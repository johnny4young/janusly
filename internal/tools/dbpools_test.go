package tools

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDbPoolConfigurationAndCanceledAdmission(t *testing.T) {
	cache := newDbPoolCache()
	defer cache.close()
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
	cache.close()
	if _, err := cache.acquire(t.Context(), "org", "db", dsn); !errors.Is(err, errDbPoolsClosed) {
		t.Fatalf("terminal shutdown: %v", err)
	}
}
