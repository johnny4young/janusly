//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"
)

// The worker fleet surface derives liveness server-side but a tenant admin
// receives only health, never global platform topology or build identity.
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
	if res.body["status"] != "degraded" {
		t.Fatalf("one live and one silent instance must read degraded: %+v", res.body)
	}
	for _, forbidden := range []string{"instances", "liveCount", "staleCount", "buildCommit", "instanceId"} {
		if _, exposed := res.body[forbidden]; exposed {
			t.Fatalf("tenant response exposed %s: %+v", forbidden, res.body)
		}
	}
	if res.body["staleAfterSeconds"] == nil {
		t.Fatalf("the staleness contract must be stated: %+v", res.body)
	}
}
