//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"strings"
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
		 VALUES ($1, $2, $3, 'wf-x', 'wfv-x', 'semantic_violation', $4, 'node-a', 'expression', 'quarantine', 'boom', $5)`,
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
	legacyID := "case-nonsemantic-" + suffix
	if _, err := testPool(t).Exec(context.Background(),
		`INSERT INTO recovery_cases (id, org_id, run_id, workflow_id, workflow_version_id, source,
		   detector_id, source_node_id, detector_kind, action, message, state)
		 VALUES ($1, $2, 'run-legacy', 'wf-x', 'wfv-x', 'technical_failure', $3,
		   'node-a', 'expression', 'quarantine', 'legacy', 'detected')`,
		legacyID, h.org, "det-"+legacyID); err != nil {
		t.Fatalf("seed nonsemantic case: %v", err)
	}

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
	if res := h.call("GET", "/recovery/cases/"+legacyID, nil, ""); res.status != 404 {
		t.Fatalf("nonsemantic case must not inherit the governed detail surface: %d %+v", res.status, res.body)
	}
}

func TestRecoveryCaseDetailProjectsOnlyCurrentBoundedApproval(t *testing.T) {
	h := newAPIHarness(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	caseID := "case-active-approval-" + suffix
	candidateID := "candidate-active-approval-" + suffix
	validationID := "validation-active-approval-" + suffix
	seedRecoveryCase(t, h.org, caseID, "run-active-approval-"+suffix, "awaiting_approval")
	if _, err := testPool(t).Exec(ctx,
		`UPDATE recovery_cases SET revision=6 WHERE org_id=$1 AND id=$2`,
		h.org, caseID); err != nil {
		t.Fatalf("set approval case revision: %v", err)
	}
	if _, err := testPool(t).Exec(ctx, `INSERT INTO recovery_case_artifacts
		(id,org_id,case_id,kind,payload_json,payload_sha256,actor_kind,actor_id)
		VALUES ($1,$2,$3,'candidate','{}',$4,'user','operator-1'),
		       ($5,$2,$3,'validation','{}',$6,'user','operator-1')`,
		candidateID, h.org, caseID, strings.Repeat("a", 64),
		validationID, strings.Repeat("b", 64)); err != nil {
		t.Fatalf("seed approval artifacts: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := testPool(t).Exec(ctx, `INSERT INTO recovery_approval_grants
		(id,org_id,case_id,candidate_artifact_id,validation_artifact_id,
		 case_revision,granted_by,expires_at,created_at)
		VALUES ($1,$2,$3,$4,$5,6,'operator-secret',$6,$7)`,
		"grant-secret-"+suffix, h.org, caseID, candidateID, validationID,
		now.Add(30*time.Minute), now); err != nil {
		t.Fatalf("seed active approval: %v", err)
	}

	detail := h.call("GET", "/recovery/cases/"+caseID, nil, "")
	if detail.status != 200 {
		t.Fatalf("approval detail: %d %+v", detail.status, detail.body)
	}
	approval, ok := detail.body["activeApproval"].(map[string]any)
	if !ok || approval["candidateArtifactId"] != candidateID ||
		approval["validationArtifactId"] != validationID ||
		approval["caseRevision"] != float64(6) || approval["expiresAt"] == nil {
		t.Fatalf("bounded active approval = %+v", detail.body["activeApproval"])
	}
	if _, exposed := approval["id"]; exposed {
		t.Fatalf("active approval exposed grant identity: %+v", approval)
	}
	if _, exposed := approval["grantedBy"]; exposed {
		t.Fatalf("active approval exposed approving actor: %+v", approval)
	}

	// Any case revision change invalidates the continuity hint before apply.
	if _, err := testPool(t).Exec(ctx,
		`UPDATE recovery_cases SET revision=7 WHERE org_id=$1 AND id=$2`,
		h.org, caseID); err != nil {
		t.Fatalf("advance approval case revision: %v", err)
	}
	stale := h.call("GET", "/recovery/cases/"+caseID, nil, "")
	if stale.status != 200 || stale.body["activeApproval"] != nil {
		t.Fatalf("stale approval must disappear: %d %+v", stale.status, stale.body)
	}
}

func TestRecoveryCaseDetailRetainsFoundationsAndNewestBoundedEvidence(t *testing.T) {
	h := newAPIHarness(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	caseID := "case-bounded-detail-" + suffix
	seedRecoveryCase(t, h.org, caseID, "run-bounded-"+suffix, "candidates_ready")

	if _, err := testPool(t).Exec(ctx, `INSERT INTO recovery_case_artifacts
		(id,org_id,case_id,kind,payload_json,payload_sha256,actor_kind,created_at)
		SELECT 'bounded-artifact-'||$3||'-'||n, $1, $2,
			CASE WHEN n <= 3 THEN 'candidate' ELSE 'validation' END,
			jsonb_build_object('sequence',n),
			md5($3||':'||n::text)||md5($3||':'||n::text), 'system',
			now()+n*interval '1 millisecond'
		FROM generate_series(1,123) AS n`, h.org, caseID, suffix); err != nil {
		t.Fatalf("seed bounded artifacts: %v", err)
	}
	if _, err := testPool(t).Exec(ctx, `INSERT INTO recovery_case_transitions
		(id,org_id,case_id,from_state,to_state,actor_kind,evidence_json,reason,occurred_at)
		SELECT 'bounded-transition-'||$3||'-'||n, $1, $2,
			'validating','candidates_ready','system','[]'::jsonb,'bounded history',
			now()+n*interval '1 millisecond'
		FROM generate_series(1,120) AS n`, h.org, caseID, suffix); err != nil {
		t.Fatalf("seed bounded transitions: %v", err)
	}

	detail := h.call("GET", "/recovery/cases/"+caseID, nil, "")
	if detail.status != 200 {
		t.Fatalf("bounded detail: %d %+v", detail.status, detail.body)
	}
	artifactRows, _ := detail.body["artifacts"].([]any)
	transitionRows, _ := detail.body["transitions"].([]any)
	if len(artifactRows) != 100 || len(transitionRows) != 100 {
		t.Fatalf("detail bounds = artifacts:%d transitions:%d, want 100/100", len(artifactRows), len(transitionRows))
	}
	artifactIDs := map[string]bool{}
	for _, raw := range artifactRows {
		artifactIDs[raw.(map[string]any)["id"].(string)] = true
	}
	for _, sequence := range []int{1, 2, 3, 123} {
		id := fmt.Sprintf("bounded-artifact-%s-%d", suffix, sequence)
		if !artifactIDs[id] {
			t.Fatalf("bounded detail omitted required foundation/current artifact %s", id)
		}
	}
	if artifactIDs[fmt.Sprintf("bounded-artifact-%s-4", suffix)] {
		t.Fatal("bounded detail retained the oldest validation instead of current evidence")
	}
	transitionIDs := map[string]bool{}
	for _, raw := range transitionRows {
		transitionIDs[raw.(map[string]any)["id"].(string)] = true
	}
	if !transitionIDs[fmt.Sprintf("bounded-transition-%s-120", suffix)] ||
		transitionIDs[fmt.Sprintf("bounded-transition-%s-1", suffix)] {
		t.Fatal("bounded transition history did not retain the newest lifecycle evidence")
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
