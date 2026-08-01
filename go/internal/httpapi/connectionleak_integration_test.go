//go:build integration

package httpapi

import (
	"context"
	"testing"
	"time"
)

// T-511: the Postgres-connection baseline gate — the LISTEN-hijack leak
// class (T-185) converted into CI. Ten full harness lifecycles (server +
// engine workers + stream hub + pools) must return the server's
// connection count to its baseline; a hijacked or orphaned connection
// per harness shows up as a monotonic climb.
func TestPostgresConnectionBaseline(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	countConns := func() int {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()`,
		).Scan(&n); err != nil {
			t.Fatalf("count connections: %v", err)
		}
		return n
	}

	// Settle, then baseline (other suites' pools have closed by now; the
	// soak lives on a different database and never counts here).
	time.Sleep(500 * time.Millisecond)
	baseline := countConns()

	for i := 0; i < 10; i++ {
		t.Run("harness", func(t *testing.T) {
			h := newAPIHarness(t)
			// One real request so every lazy component (hub, workers,
			// resolver) actually opens whatever it opens.
			if res := h.call("GET", "/v1/runs?limit=1", nil, ""); res.status != 200 {
				t.Fatalf("probe request: %d", res.status)
			}
		})
	}

	// Cleanups ran at each subtest end; allow pgx close to settle.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if now := countConns(); now <= baseline+2 {
			// +2 tolerance: a health-check connection mid-recycle on the
			// shared test pool is legal churn, a climb of 10 is a leak.
			return
		} else if time.Now().After(deadline) {
			t.Fatalf("connection leak: baseline %d, now %d after 10 harness lifecycles", baseline, now)
		}
		time.Sleep(250 * time.Millisecond)
	}
}
