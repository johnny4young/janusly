//go:build integration

package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/engine"
)

// The catalog governing for real: runs.requireSavedWorkflow forbids adhoc
// starts with the contract's verbatim 403, while a SAVED workflow keeps
// running; per-org retention windows drive the tombstone purge.
func TestOrgConfigGovernsStartAndRetention(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()

	// Flip the tenant gate, then try an adhoc (unsaved) start.
	if res := h.call("POST", "/org/config", map[string]any{
		"key": "runs.requireSavedWorkflow", "value": true,
	}, ""); res.status != 200 {
		t.Fatalf("set gate: %+v", res.body)
	}
	adhoc := map[string]any{
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	denied := h.call("POST", "/v1/start", map[string]any{"workflow": adhoc}, "")
	if denied.status != 403 {
		t.Fatalf("adhoc must 403: %d %+v", denied.status, denied.body)
	}
	enveloped := denied.body["error"].(map[string]any)
	if enveloped["code"] != "runs_adhoc_disabled" ||
		enveloped["message"] != "Ad-hoc workflows are disabled. Save the workflow first." {
		t.Fatalf("verbatim reference rejection: %+v", enveloped)
	}

	// A saved workflow passes the gate and audits as a NON-adhoc start.
	wfID := "wf-saved-" + h.org
	saved := map[string]any{
		"id": wfID, "name": "Saved Flow",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/v1/workflows/save", saved, ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": saved}, "")
	if started.status != 200 {
		t.Fatalf("saved start must pass: %d %+v", started.status, started.body)
	}
	runID := started.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "succeeded")
	if got := countAudit(t, pool, h.org, "run.started"); got != 1 {
		t.Fatalf("saved start audits run.started: %d", got)
	}
	if got := countAudit(t, pool, h.org, "run.started.adhoc"); got != 0 {
		t.Fatalf("saved start must not audit adhoc: %d", got)
	}

	// Per-org retention: this org narrows its window to 1 day; a second
	// org keeps the default 30. Both tombstone a workflow 5 days ago —
	// only the narrow org's row is purged by the sweep.
	otherOrg := h.org + "-other"
	fiveDaysAgo := time.Now().UTC().AddDate(0, 0, -5)
	seedTombstone := func(org, id string) {
		if _, err := pool.Exec(ctx, `INSERT INTO workflows (id, org_id, name, deleted_at)
			VALUES ($1, $2, 'doomed', $3)`, id, org, fiveDaysAgo); err != nil {
			t.Fatalf("seed tombstone: %v", err)
		}
	}
	seedTombstone(h.org, "wf-doomed-"+h.org)
	seedTombstone(otherOrg, "wf-doomed-"+otherOrg)
	// The schema has no foreign keys: the purge itself is the cascade over
	// the workflow's dependants.
	seedDependants := func(org, workflowID string) {
		for _, statement := range []string{
			`INSERT INTO workflow_status_pages (org_id, workflow_id, token_digest) VALUES ($1, $2, $2 || '-digest')`,
			`INSERT INTO workflow_budgets (id, org_id, workflow_id, monthly_usd) VALUES ($2 || '-budget', $1, $2, 10)`,
			`INSERT INTO workflow_input_presets (id, org_id, workflow_id, name, input_json) VALUES ($2 || '-preset', $1, $2, 'preset', '{}')`,
			`INSERT INTO schedule_entries (id, org_id, workflow_id, workflow_version_id, node_id, cron_expression, next_fire_at)
			   VALUES ($2 || '-schedule', $1, $2, $2 || '-v1', 'tick', '0 9 * * *', now() + interval '1 day')`,
			`INSERT INTO workflow_improvements (id, org_id, workflow_id) VALUES ($2 || '-improvement', $1, $2)`,
		} {
			if _, err := pool.Exec(ctx, statement, org, workflowID); err != nil {
				t.Fatalf("seed dependant: %v", err)
			}
		}
	}
	seedDependants(h.org, "wf-doomed-"+h.org)
	seedDependants(otherOrg, "wf-doomed-"+otherOrg)
	if res := h.call("POST", "/org/config", map[string]any{
		"key": "retention.deletedWorkflowsDays", "value": float64(1),
	}, ""); res.status != 200 {
		t.Fatalf("set window: %+v", res.body)
	}

	eng := engine.New(pool)
	purged, err := eng.ProcessRetentionSweep(ctx, 30)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if purged < 1 {
		t.Fatalf("narrow window must purge: %d", purged)
	}
	countRows := func(org string) int {
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflows
			WHERE org_id = $1 AND deleted_at IS NOT NULL`, org).Scan(&n)
		return n
	}
	if got := countRows(h.org); got != 0 {
		t.Fatalf("1-day window org must be purged, %d rows left", got)
	}
	if got := countRows(otherOrg); got != 1 {
		t.Fatalf("default-window org must keep its tombstone, got %d", got)
	}
	countDependants := func(org string) int {
		var n int
		_ = pool.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM workflow_status_pages WHERE org_id = $1) +
			(SELECT count(*) FROM workflow_budgets WHERE org_id = $1) +
			(SELECT count(*) FROM workflow_input_presets WHERE org_id = $1) +
			(SELECT count(*) FROM schedule_entries WHERE org_id = $1) +
			(SELECT count(*) FROM workflow_improvements WHERE org_id = $1)`, org).Scan(&n)
		return n
	}
	if got := countDependants(h.org); got != 0 {
		t.Fatalf("the purge must take the workflow's dependants with it, %d rows left", got)
	}
	if got := countDependants(otherOrg); got != 5 {
		t.Fatalf("the other org's dependants must survive, got %d of 5", got)
	}
}
