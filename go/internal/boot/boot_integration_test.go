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

func pilotDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set; run through `make test`")
	}
	return dsn
}

func TestConnectAndProbeAgainstMigratedDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := Connect(ctx, pilotDatabaseURL(t), 10)
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

	// The server's maintenance database exists but never carries the drizzle
	// journal, which makes it a faithful stand-in for an unmigrated target.
	parsed, err := url.Parse(pilotDatabaseURL(t))
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	parsed.Path = "/postgres"

	pool, err := Connect(ctx, parsed.String(), 10)
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

	_, err := Connect(ctx, "postgres://nobody:nothing@127.0.0.1:1/void", 10)
	if err == nil {
		t.Fatal("expected a connection error")
	}
}
