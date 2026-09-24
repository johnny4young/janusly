package tools

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestDbPoolConfigurationAndCanceledAdmission(t *testing.T) {
	cache := testDBPools(t, 25)
	defer cache.Close()
	// Pool creation is lazy, so this tests policy without contacting a server.
	const dsn = "postgres://test:test@127.0.0.1:1/test?pool_max_conns=50&pool_min_conns=20&pool_min_idle_conns=20"
	lease, err := cache.acquire(t.Context(), "org", "db", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	config := lease.pool.Config()
	if config.MaxConns != 1 || config.MinConns != 0 || config.MinIdleConns != 0 || config.ConnConfig.ConnectTimeout != 10*time.Second {
		t.Fatal("credential parameters overrode physical pool limits")
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := cache.acquire(canceled, "org", "db", dsn); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled warm admission: %v", err)
	}
	if _, err := cache.acquire(canceled, "org", "new", dsn); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled new admission: %v", err)
	}
	lease.Release()
	cache.Close()
	if _, err := cache.acquire(t.Context(), "org", "db", dsn); !errors.Is(err, errDbPoolsClosed) {
		t.Fatalf("terminal shutdown: %v", err)
	}
}

func TestDbPoolInvalidRotationKeepsCachedPool(t *testing.T) {
	cache := testDBPools(t, 25)
	const dsn = "postgres://test:test@127.0.0.1:1/test"
	first, err := cache.acquire(t.Context(), "org", "db", dsn)
	if err != nil {
		t.Fatal(err)
	}
	first.Release()
	if _, err := cache.acquire(t.Context(), "org", "db", "postgres://%zz"); err == nil || err.Error() != "invalid postgres credential value" {
		t.Fatalf("invalid rotation: %v", err)
	}
	warm, err := cache.acquire(t.Context(), "org", "db", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer warm.Release()
	if warm.pool != first.pool {
		t.Fatal("invalid rotation retired the cached pool")
	}
}

func testDBPools(t *testing.T, maxPools int) *DBPools {
	t.Helper()
	pools, err := NewDBPools(maxPools)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pools.Close)
	return pools
}

func TestDBPoolsOwnImmutableIndependentBudgets(t *testing.T) {
	const dsn = "postgres://test:test@127.0.0.1:1/test"
	baseline := testutil.ToFloat64(metricDbToolPools)
	first, second := testDBPools(t, 1), testDBPools(t, 2)
	t.Setenv("JANUSLY_DB_TOOL_MAX_PROCESS_POOLS", "500")
	a, err := first.acquire(t.Context(), "a", "db", dsn)
	if err != nil {
		t.Fatal(err)
	}
	a.Release()
	unexpected, err := first.acquire(t.Context(), "b", "db", dsn)
	if unexpected != nil {
		unexpected.Release()
	}
	if !errors.Is(err, errDbPoolExhausted) {
		t.Fatalf("env changed captured cap: %v", err)
	}
	for _, org := range []string{"a", "b"} {
		lease, err := second.acquire(t.Context(), org, "db", dsn)
		if err != nil {
			t.Fatal(err)
		}
		lease.Release()
	}
	if got := testutil.ToFloat64(metricDbToolPools); got != baseline+3 {
		t.Fatalf("aggregate gauge=%v", got)
	}
	first.Close()
	if got := testutil.ToFloat64(metricDbToolPools); got != baseline+2 {
		t.Fatalf("one owner erased another owner's gauge=%v", got)
	}
	warm, err := second.acquire(t.Context(), "a", "db", dsn)
	if err != nil {
		t.Fatalf("closing first owner closed second: %v", err)
	}
	warm.Release()
	second.Close()
	if got := testutil.ToFloat64(metricDbToolPools); got != baseline {
		t.Fatalf("leaked pools=%v", got)
	}
	for _, invalid := range []int{-1, 0, 501} {
		if pools, err := NewDBPools(invalid); err == nil || pools != nil {
			t.Fatalf("accepted invalid cap=%d", invalid)
		}
	}
}

func TestDBToolWithoutPoolOwnerFailsBeforeCredentialGate(t *testing.T) {
	called := false
	deps := &IntegrationDeps{Gate: func(context.Context, string, string, string, int) (string, string) { called = true; return "", "" }}
	result := executeDbTool(t.Context(), "db.query.read", map[string]any{"credential": "db", "sql": "select 1"}, deps)
	if result["ok"] != false || result["error"] != "external database pools not configured" || called {
		t.Fatalf("missing pool owner did not fail closed: %v gate=%v", result, called)
	}
}
