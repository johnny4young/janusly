//go:build integration

package httpapi

import (
	"context"
	"testing"
	"time"
)

// Two-tier health: the open route never exposes live queue numbers, and
// the admin snapshot reports waiting/active plus age measured from
// ELIGIBILITY with the warn threshold flipping degraded.
func TestTwoTierQueueHealth(t *testing.T) {
	t.Setenv("JANUSLY_QUEUE_LAG_WARN_SECONDS", "1")
	t.Setenv("JANUSLY_MAINTENANCE_QUEUE_LAG_WARN_SECONDS", "7")
	pool := testPool(t)
	ctx := context.Background()

	// A stale eligible queued node: running run, queued node, and its
	// node.queued event 120 seconds in the past (the eligibility instant).
	org := "org-qhealth"
	runID := "run-qhealth"
	_, _ = pool.Exec(ctx, `DELETE FROM run_events WHERE run_id = 'run-qhealth'`)
	_, _ = pool.Exec(ctx, `DELETE FROM run_nodes WHERE run_id = 'run-qhealth'`)
	_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = 'run-qhealth'`)
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
		VALUES ($1, $2, 'running', '{}', 'wv-q')`, runID, org); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_nodes (id, run_id, node_id, status)
		VALUES ($1, $2, 'slow', 'queued')`, runID+"-slow", runID); err != nil {
		t.Fatalf("seed node: %v", err)
	}
	queuedAt := time.Now().UTC().Add(-120 * time.Second)
	if _, err := pool.Exec(ctx, `INSERT INTO run_events (id, run_id, node_id, type, payload, created_at)
		VALUES ($1, $2, 'slow', 'node.queued', '{}', $3)`,
		runID+"-ev-"+time.Now().Format("150405.000"), runID, queuedAt); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM run_events WHERE run_id = 'run-qhealth'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM run_nodes WHERE run_id = 'run-qhealth'`)
		_, _ = pool.Exec(context.Background(), `DELETE FROM runs WHERE id = 'run-qhealth'`)
	})
	// Fresh harness = fresh 5s snapshot cache.
	// It deliberately owns no workers: a worker racing this read would claim
	// the seeded queued row and make an observability assertion nondeterministic.
	h := newAPIHarnessWithoutWorkers(t)

	// Admin detail: the stale node counts, its age measured from the
	// queued event, maintenance projected as a drained in-process lane.
	admin := h.call("GET", "/system/queue", nil, "")
	if admin.status != 200 {
		t.Fatalf("admin queue: %d %+v", admin.status, admin.body)
	}
	if admin.body["waiting"].(float64) < 1 {
		t.Fatalf("stale node must count as waiting: %+v", admin.body)
	}
	oldest, ok := admin.body["oldestWaitingSeconds"].(float64)
	if !ok || oldest < 100 {
		t.Fatalf("age must run from eligibility (~120s): %v", admin.body["oldestWaitingSeconds"])
	}
	if admin.body["warnSeconds"] != float64(1) {
		t.Fatalf("env warn threshold: %+v", admin.body)
	}
	maintenance, ok := admin.body["maintenance"].(map[string]any)
	if !ok || maintenance["waiting"] != float64(0) || maintenance["active"] != float64(0) ||
		maintenance["oldestWaitingSeconds"] != nil || maintenance["warnSeconds"] != float64(7) {
		t.Fatalf("maintenance drained-lane projection: %+v", admin.body)
	}

	// Public /health: coarse degraded=true (age > warn) and NEVER the
	// live numbers.
	public := h.call("GET", "/health", nil, "")
	queue := public.body["queue"].(map[string]any)
	if queue["degraded"] != true {
		t.Fatalf("stale queue must degrade: %+v", queue)
	}
	for _, forbidden := range []string{"waiting", "active", "oldestWaitingSeconds", "warnSeconds"} {
		if _, leaked := queue[forbidden]; leaked {
			t.Fatalf("public queue block must not leak %s: %+v", forbidden, queue)
		}
	}
	if _, hasLimiter := public.body["rateLimiter"].(map[string]any); !hasLimiter {
		t.Fatalf("rateLimiter block missing: %+v", public.body)
	}

	// Admin rate-limiter triage snapshot answers with the full shape.
	limiter := h.call("GET", "/system/rate-limiter", nil, "")
	if limiter.status != 200 || limiter.body["healthy"] == nil {
		t.Fatalf("admin limiter snapshot: %d %+v", limiter.status, limiter.body)
	}
}
