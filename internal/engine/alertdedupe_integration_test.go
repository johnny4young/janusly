//go:build integration

package engine

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

// Alert dedupe is a claim, not a read-then-write: concurrent producers
// (two replicas, or two reapers racing the same stalled node) must page
// exactly once for one dedupe key inside the cooldown window.
func TestAlertDispatchClaimsExactlyOnceUnderConcurrency(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")

	var hits atomic.Int64
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer receiver.Close()

	policyID := "policy-" + org
	channels := fmt.Sprintf(`[{"type":"webhook","params":{"url":%q}}]`, receiver.URL)
	if _, err := pool.Exec(ctx, `INSERT INTO alert_policies
		(id, org_id, name, trigger, parameters, channels, cooldown_seconds, enabled)
		VALUES ($1, $2, 'dedupe-test', 'dlq.entry_created', '{}'::jsonb, $3::jsonb, 900, true)`,
		policyID, org, channels); err != nil {
		t.Fatalf("seed policy: %v", err)
	}

	const producers = 8
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range producers {
		wg.Go(func() {
			<-start
			eng.DispatchAlert(ctx, org, "dlq.entry_created", map[string]any{
				"dedupeKey": "same-failure", "deadLetterId": "dl-1",
			})
		})
	}
	close(start)
	wg.Wait()

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM alert_dispatches WHERE org_id = $1 AND policy_id = $2`,
		org, policyID).Scan(&rows); err != nil {
		t.Fatalf("count dispatches: %v", err)
	}
	if rows != 1 {
		t.Fatalf("cooldown must admit exactly one dispatch row, got %d", rows)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("the webhook must be delivered exactly once, got %d", got)
	}
	var outcome string
	if err := pool.QueryRow(ctx,
		`SELECT outcome FROM alert_dispatches WHERE org_id = $1 AND policy_id = $2`,
		org, policyID).Scan(&outcome); err != nil {
		t.Fatalf("read outcome: %v", err)
	}
	if outcome != "delivered" {
		t.Fatalf("a delivered dispatch must settle as delivered, got %q", outcome)
	}
}
