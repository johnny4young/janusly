//go:build integration

package tools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// The per-org 5-pool budget nests under a PROCESS-wide semaphore.
// At the cap a net-new pool answers the stable db_pool_exhausted sentinel
// (never-throw at the tool layer), warm pools keep serving, and the gauge
// tracks the live total.

func TestGlobalDbPoolCap(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set; run through `make test`")
	}
	t.Setenv("JANUSLY_GO_DB_TOOL_MAX_PROCESS_POOLS", "10")
	ResetDbPoolsForTests()
	t.Cleanup(ResetDbPoolsForTests)
	ctx := context.Background()

	// 2 orgs × 5 credentials fill the process cap exactly — the per-org
	// budget (5) is respected while the global total reaches 10.
	for org := 0; org < 2; org++ {
		for cred := 0; cred < 5; cred++ {
			if _, err := getDbPool(ctx, fmt.Sprintf("cap-org-%d", org), fmt.Sprintf("cred-%d", cred), dsn); err != nil {
				t.Fatalf("org %d cred %d must open below the cap: %v", org, cred, err)
			}
		}
	}
	if got := testutil.ToFloat64(metricDbToolPools); got != 10 {
		t.Fatalf("gauge must track the live total, got %v", got)
	}

	// A third org's NET-NEW pool hits the semaphore: stable sentinel, no
	// cross-org eviction (the warm pools survive and keep serving).
	if _, err := getDbPool(ctx, "cap-org-2", "cred-0", dsn); !errors.Is(err, errDbPoolExhausted) {
		t.Fatalf("past the cap must answer the exhausted sentinel, got %v", err)
	}
	if safeDbError(errDbPoolExhausted) != "db_pool_exhausted" {
		t.Fatalf("tool envelope must carry the literal code: %q", safeDbError(errDbPoolExhausted))
	}
	if got := testutil.ToFloat64(metricDbToolPools); got != 10 {
		t.Fatalf("a rejected pool must not move the gauge, got %v", got)
	}
	if pool, err := getDbPool(ctx, "cap-org-0", "cred-3", dsn); err != nil || pool == nil {
		t.Fatalf("warm pools must keep serving at the cap: %v", err)
	}

	// An org past ITS OWN budget swaps its LRU (net-zero) even at the
	// process cap — the sixth credential evicts cred-0, total stays 10.
	if _, err := getDbPool(ctx, "cap-org-0", "cred-5", dsn); err != nil {
		t.Fatalf("per-org LRU swap must succeed at the global cap: %v", err)
	}
	if got := testutil.ToFloat64(metricDbToolPools); got != 10 {
		t.Fatalf("LRU swap is net-zero, got %v", got)
	}

	// Reset drains everything and the gauge follows.
	ResetDbPoolsForTests()
	if got := testutil.ToFloat64(metricDbToolPools); got != 0 {
		t.Fatalf("reset must zero the gauge, got %v", got)
	}
	if _, err := getDbPool(ctx, "cap-org-2", "cred-0", dsn); err != nil {
		t.Fatalf("capacity must recover after reset: %v", err)
	}
}
