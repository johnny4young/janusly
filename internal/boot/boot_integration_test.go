//go:build integration

package boot

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"
)

func runtimeDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	return dsn
}

func TestConnectAndProbeAgainstMigratedDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := Connect(ctx, runtimeDatabaseURL(t), 10, PoolRoleAPI)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	if err := ProbeMigrations(ctx, pool); err != nil {
		t.Fatalf("probe against migrated database must pass: %v", err)
	}
}

func TestProbeFailsAgainstUnmigratedDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// The server's maintenance database exists but never carries the Janusly
	// journal, which makes it a faithful stand-in for an unmigrated target.
	parsed, err := url.Parse(runtimeDatabaseURL(t))
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	parsed.Path = "/postgres"

	pool, err := Connect(ctx, parsed.String(), 10, PoolRoleAPI)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	err = ProbeMigrations(ctx, pool)
	if !errors.Is(err, ErrNotMigrated) {
		t.Fatalf("expected ErrNotMigrated, got: %v", err)
	}
}

func TestConnectRejectsUnreachableServer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := Connect(ctx, "postgres://nobody:nothing@127.0.0.1:1/void", 10, PoolRoleAPI)
	if err == nil {
		t.Fatal("expected a connection error")
	}
}

// Every pooled connection carries the role's session limits, so a runaway
// statement, a lock wait or a forgotten transaction cancels on the server.
func TestPoolsCarrySessionLimitsPerRole(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for role, want := range map[PoolRole]map[string]string{
		PoolRoleAPI:    {"statement_timeout": "15s", "lock_timeout": "5s", "idle_in_transaction_session_timeout": "30s"},
		PoolRoleWorker: {"statement_timeout": "1min", "lock_timeout": "5s", "idle_in_transaction_session_timeout": "30s"},
	} {
		pool, err := Connect(ctx, runtimeDatabaseURL(t), 2, role)
		if err != nil {
			t.Fatalf("connect: %v", err)
		}
		for setting, expected := range want {
			var got string
			if err := pool.QueryRow(ctx, "SHOW "+setting).Scan(&got); err != nil {
				t.Fatalf("show %s: %v", setting, err)
			}
			if got != expected {
				t.Fatalf("role %d %s = %q, want %q", role, setting, got, expected)
			}
		}
		pool.Close()
	}
}
