//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"
)

// The worker fleet surface: heartbeats upsert one row per instance, the
// admin route derives liveness server-side, and silent rows read stale.
func TestWorkerFleetSurface(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	liveID, staleID := "inst-live-"+suffix, "inst-stale-"+suffix

	for range 2 { // the second beat must UPDATE, never duplicate
		if _, err := pool.Exec(ctx, `INSERT INTO worker_instances
			(instance_id, worker_concurrency, build_commit)
			VALUES ($1, 8, 'abc123')
			ON CONFLICT (instance_id) DO UPDATE SET last_seen_at = now()`, liveID); err != nil {
			t.Fatalf("beat: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO worker_instances
		(instance_id, worker_concurrency, last_seen_at)
		VALUES ($1, 4, now() - interval '10 minutes')`, staleID); err != nil {
		t.Fatalf("seed stale: %v", err)
	}

	res := h.call("GET", "/system/workers", nil, "")
	if res.status != 200 {
		t.Fatalf("list workers: %d %+v", res.status, res.body)
	}
	instances, _ := res.body["instances"].([]any)
	byID := map[string]map[string]any{}
	for _, raw := range instances {
		row := raw.(map[string]any)
		byID[row["instanceId"].(string)] = row
	}
	if byID[liveID] == nil || byID[liveID]["status"] != "live" || byID[liveID]["buildCommit"] != "abc123" {
		t.Fatalf("live instance projection: %+v", byID[liveID])
	}
	if byID[staleID] == nil || byID[staleID]["status"] != "stale" {
		t.Fatalf("a silent instance must read stale: %+v", byID[staleID])
	}
	if res.body["staleAfterSeconds"] == nil {
		t.Fatalf("the staleness contract must be stated: %+v", res.body)
	}
}
