//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/engine"
)

// The schedule due-clock loop: save registers entries, a due tick fires a
// run against the entry's exact version, a paused workflow DROPS the tick
// loudly (clock still advances), soft delete removes the entries, and a
// new save without the node deregisters it.
func TestScheduleNodeDueClockLoop(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-sched-" + suffix

	workflow := map[string]any{
		"id": wfID, "name": "Nightly", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "tick", "type": "schedule",
				"config": map[string]any{"cron": "0 3 * * *"}},
			map[string]any{"id": "step", "type": "transform",
				"config": map[string]any{"mapping": map[string]any{
					"via": "{{context.input.triggeredBy}}",
				}}},
		},
		"edges": []any{map[string]any{"from": "tick", "to": "step"}},
	}
	if res := h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}

	// Save registered the entry with a REAL future fire time.
	var entryID, cronExpression string
	var nextFireAt time.Time
	if err := pool.QueryRow(ctx,
		`SELECT id, cron_expression, next_fire_at FROM schedule_entries WHERE org_id = $1 AND workflow_id = $2`,
		h.org, wfID).Scan(&entryID, &cronExpression, &nextFireAt); err != nil {
		t.Fatalf("entry after save: %v", err)
	}
	if cronExpression != "0 3 * * *" || !nextFireAt.After(time.Now()) {
		t.Fatalf("entry shape: %s %v", cronExpression, nextFireAt)
	}

	// Force the clock due → the sweep fires exactly one run.
	if _, err := pool.Exec(ctx,
		`UPDATE schedule_entries SET next_fire_at = now() - interval '1 minute' WHERE id = $1`, entryID); err != nil {
		t.Fatalf("force due: %v", err)
	}
	eng := engine.New(pool)
	fired, dropped := eng.SweepDueSchedules(ctx)
	if fired != 1 || dropped != 0 {
		t.Fatalf("sweep: fired=%d dropped=%d", fired, dropped)
	}
	var lastRunID string
	_ = pool.QueryRow(ctx, `SELECT coalesce(last_run_id,'') FROM schedule_entries WHERE id = $1`, entryID).Scan(&lastRunID)
	if lastRunID == "" {
		t.Fatal("entry must record the fired run")
	}
	h.waitRun(lastRunID, "succeeded")
	var via string
	_ = pool.QueryRow(ctx,
		`SELECT state_json->'output'->>'via' FROM run_nodes WHERE run_id = $1 AND node_id = 'step'`,
		lastRunID).Scan(&via)
	if via != "schedule" {
		t.Fatalf("run input must carry triggeredBy schedule: %q", via)
	}
	// The clock advanced to the NEXT cron fire, not the lease.
	_ = pool.QueryRow(ctx, `SELECT next_fire_at FROM schedule_entries WHERE id = $1`, entryID).Scan(&nextFireAt)
	if !nextFireAt.After(time.Now().Add(30 * time.Minute)) {
		t.Fatalf("clock must advance to the next cron fire: %v", nextFireAt)
	}

	// A PAUSED workflow drops the tick loudly — no run, audited, advanced.
	if _, err := pool.Exec(ctx,
		`UPDATE workflows SET status = 'paused_upstream_degraded' WHERE id = $1`, wfID); err != nil {
		t.Fatalf("pause: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE schedule_entries SET next_fire_at = now() - interval '1 minute' WHERE id = $1`, entryID); err != nil {
		t.Fatalf("force due again: %v", err)
	}
	fired, dropped = eng.SweepDueSchedules(ctx)
	if fired != 0 || dropped != 1 {
		t.Fatalf("paused sweep: fired=%d dropped=%d", fired, dropped)
	}
	var dropAudits int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'schedule.tick.dropped' AND target_id = $2`,
		h.org, wfID).Scan(&dropAudits)
	if dropAudits != 1 {
		t.Fatalf("drop must be audited once: %d", dropAudits)
	}
	var runCount int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM runs r JOIN workflow_versions wv ON wv.id = r.workflow_version_id WHERE wv.workflow_id = $1`,
		wfID).Scan(&runCount)
	if runCount != 1 {
		t.Fatalf("paused tick must not run: %d runs", runCount)
	}
	_, _ = pool.Exec(ctx, `UPDATE workflows SET status = 'active' WHERE id = $1`, wfID)

	// Soft delete removes the entries in the same transaction.
	if res := h.call("DELETE", "/workflows/"+wfID, nil, ""); res.status != 200 {
		t.Fatalf("delete: %d %+v", res.status, res.body)
	}
	var remaining int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM schedule_entries WHERE workflow_id = $1`, wfID).Scan(&remaining)
	if remaining != 0 {
		t.Fatalf("tombstone must deregister schedules: %d", remaining)
	}
	// Restore re-registers from the latest version.
	if res := h.call("POST", "/workflows/"+wfID+"/restore", nil, ""); res.status != 200 {
		t.Fatalf("restore: %d %+v", res.status, res.body)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM schedule_entries WHERE workflow_id = $1`, wfID).Scan(&remaining)
	if remaining != 1 {
		t.Fatalf("restore must re-register: %d", remaining)
	}

	// A new save WITHOUT the node deregisters it.
	workflow["nodes"] = []any{map[string]any{"id": "step", "type": "noop", "config": map[string]any{}}}
	workflow["edges"] = []any{}
	if res := h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("re-save: %+v", res.body)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM schedule_entries WHERE workflow_id = $1`, wfID).Scan(&remaining)
	if remaining != 0 {
		t.Fatalf("removing the node must deregister: %d", remaining)
	}
}
