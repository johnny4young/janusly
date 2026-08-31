//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// The three Recovery V2 read projections — durable cases (bounded
// list + detail), the constant-time ledger, and per-operator momentum.
// Reads only; the seeds go straight to the tables the writers own.

func seedRecoveryCase(t *testing.T, org, id, runID, state string) {
	t.Helper()
	if _, err := testPool(t).Exec(context.Background(),
		`INSERT INTO recovery_cases (id, org_id, run_id, workflow_id, workflow_version_id, source,
		   detector_id, source_node_id, detector_kind, action, message, state)
		 VALUES ($1, $2, $3, 'wf-x', 'wfv-x', 'contract', $4, 'node-a', 'expression', 'quarantine', 'boom', $5)`,
		id, org, runID, "det-"+id, state); err != nil {
		t.Fatalf("seed case: %v", err)
	}
}

func TestRecoveryCaseReads(t *testing.T) {
	h := newAPIHarness(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	seedRecoveryCase(t, h.org, "case-open-"+suffix, "run-1", "detected")
	seedRecoveryCase(t, h.org, "case-mon-"+suffix, "run-2", "monitoring")
	seedRecoveryCase(t, h.org, "case-done-"+suffix, "run-1", "verified_recovered")
	seedRecoveryCase(t, "other-org-"+suffix, "case-foreign-"+suffix, "run-9", "detected")

	// Default: open only (terminal states excluded), org-scoped.
	open := h.call("GET", "/recovery/cases", nil, "")
	if open.status != 200 || len(open.body["cases"].([]any)) != 2 {
		t.Fatalf("open cases: %d %+v", open.status, open.body)
	}
	// openOnly=false includes terminal; runId narrows.
	all := h.call("GET", "/recovery/cases?openOnly=false", nil, "")
	if len(all.body["cases"].([]any)) != 3 {
		t.Fatalf("all cases: %+v", all.body)
	}
	byRun := h.call("GET", "/recovery/cases?openOnly=false&runId=run-1", nil, "")
	if len(byRun.body["cases"].([]any)) != 2 {
		t.Fatalf("runId filter: %+v", byRun.body)
	}
	if capped := h.call("GET", "/recovery/cases?openOnly=false&limit=1", nil, ""); len(capped.body["cases"].([]any)) != 1 {
		t.Fatalf("limit cap: %+v", capped.body)
	}

	// Detail: full shape; foreign/unknown → 404.
	detail := h.call("GET", "/recovery/cases/case-open-"+suffix, nil, "")
	caseView, _ := detail.body["case"].(map[string]any)
	autonomy, _ := detail.body["autonomy"].(map[string]any)
	if detail.status != 200 || caseView["state"] != "detected" || caseView["detectorKind"] != "expression" {
		t.Fatalf("detail: %d %+v", detail.status, detail.body)
	}
	if autonomy["source"] != "unavailable" || autonomy["unavailableReason"] != "contract_missing" {
		t.Fatalf("missing run must degrade autonomy without hiding the case: %+v", autonomy)
	}
	if res := h.call("GET", "/recovery/cases/case-foreign-"+suffix, nil, ""); res.status != 404 {
		t.Fatalf("foreign case must 404: %d", res.status)
	}
}

func TestRecoveryLedgerAndMyWins(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())

	// Zero ledger before any impact.
	empty := h.call("GET", "/recovery/ledger", nil, "")
	if empty.status != 200 || empty.body["totalRecovered"] != float64(0) || empty.body["sinceIso"] != nil {
		t.Fatalf("empty ledger: %+v", empty.body)
	}

	// Seed: one production run + rollup + two attributed events (one by
	// the caller, one by someone else) + one sandbox-lineage event that
	// must NOT count.
	prodRun, sandboxRun := "run-prod-"+suffix, "run-sandbox-"+suffix
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, 'wfv', 'succeeded', '{}'), ($3, $2, 'wfv', 'succeeded', '{}')`,
		prodRun, h.org, sandboxRun); err != nil {
		t.Fatalf("seed runs: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET replay_mode = 'validation' WHERE id = $1`, sandboxRun); err != nil {
		t.Fatalf("mark sandbox: %v", err)
	}
	now := time.Now()
	for i, seed := range []struct {
		dlq, runID, user string
	}{
		{"dl-a-" + suffix, prodRun, "api-tester"},
		{"dl-b-" + suffix, prodRun, "someone-else"},
		{"dl-c-" + suffix, sandboxRun, "api-tester"},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO recovery_impact_events (dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms)
			 VALUES ($1, $2, $3, 'n', $4, $5, 1000)`,
			seed.dlq, h.org, seed.runID, seed.user, now.Add(-time.Duration(i)*time.Hour)); err != nil {
			t.Fatalf("seed impact: %v", err)
		}
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO recovery_impact_rollups (org_id, total_recovered, downtime_ended_ms, first_recovered_at, updated_at)
		 VALUES ($1, 3, 3000, $2, $2)`, h.org, now.Add(-48*time.Hour)); err != nil {
		t.Fatalf("seed rollup: %v", err)
	}

	ledger := h.call("GET", "/recovery/ledger", nil, "")
	if ledger.body["totalRecovered"] != float64(3) || ledger.body["downtimeEndedMs"] != float64(3000) || ledger.body["sinceIso"] == nil {
		t.Fatalf("ledger: %+v", ledger.body)
	}

	// My-wins: caller identity only, sandbox lineage excluded → exactly 1.
	wins := h.call("GET", "/recovery/my-wins", nil, "")
	if wins.status != 200 || wins.body["recovered"] != float64(1) || wins.body["windowDays"] != float64(30) {
		t.Fatalf("my-wins: %+v", wins.body)
	}
	// Window clamp: days > 90 clamps to 90; tiny window excludes old rows.
	if res := h.call("GET", "/recovery/my-wins?days=500", nil, ""); res.body["windowDays"] != float64(90) {
		t.Fatalf("window clamp: %+v", res.body)
	}
}
