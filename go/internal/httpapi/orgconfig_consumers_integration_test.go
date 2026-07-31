//go:build integration

package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/engine"
)

// The catalog governing for real: runs.requireSavedWorkflow forbids adhoc
// starts with the reference's verbatim 403, while a SAVED workflow keeps
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
}
