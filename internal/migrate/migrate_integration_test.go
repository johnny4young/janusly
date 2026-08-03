//go:build integration

package migrate

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func migrationDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	return dsn
}

func createMigrationTestDatabase(t *testing.T) string {
	t.Helper()
	parsed, err := url.Parse(migrationDatabaseURL(t))
	if err != nil {
		t.Fatalf("parse integration database URL: %v", err)
	}
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := open(adminURL.String())
	if err != nil {
		t.Fatalf("open PostgreSQL maintenance database: %v", err)
	}
	defer func() { _ = admin.Close() }()

	name := fmt.Sprintf("janusly_migrate_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(context.Background(),
		`CREATE DATABASE "`+name+`" TEMPLATE template0`); err != nil {
		t.Fatalf("create isolated migration database: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cleanup, openErr := open(adminURL.String())
		if openErr != nil {
			t.Errorf("open maintenance database for cleanup: %v", openErr)
			return
		}
		defer func() { _ = cleanup.Close() }()
		if _, dropErr := cleanup.ExecContext(ctx,
			`DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`); dropErr != nil {
			t.Errorf("drop isolated migration database: %v", dropErr)
		}
	})

	targetURL := *parsed
	targetURL.Path = "/" + name
	return targetURL.String()
}

func TestFreshMigrationIsIdempotentAndComplete(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	dsn := createMigrationTestDatabase(t)

	if err := AssertMigrated(ctx, dsn); err == nil || !strings.Contains(err.Error(), "database is not migrated") {
		t.Fatalf("empty database must fail the boot gate: %v", err)
	}
	if err := Up(ctx, dsn); err != nil {
		t.Fatalf("migrate fresh database: %v", err)
	}
	if err := Up(ctx, dsn); err != nil {
		t.Fatalf("repeat migration idempotently: %v", err)
	}
	if err := AssertMigrated(ctx, dsn); err != nil {
		t.Fatalf("migrated database must pass the boot gate: %v", err)
	}

	db, err := open(dsn)
	if err != nil {
		t.Fatalf("open migrated database: %v", err)
	}
	defer func() { _ = db.Close() }()

	var serverVersion int
	if err := db.QueryRowContext(ctx, `SHOW server_version_num`).Scan(&serverVersion); err != nil {
		t.Fatalf("read PostgreSQL version: %v", err)
	}
	if serverVersion < 180000 || serverVersion >= 190000 {
		t.Fatalf("integration database must be PostgreSQL 18, got server_version_num=%d", serverVersion)
	}

	var current int64
	if err := db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version_id) FILTER (WHERE is_applied), 0) FROM janusly_schema_version`).Scan(&current); err != nil {
		t.Fatalf("read migrated version: %v", err)
	}
	if current != 1 {
		t.Fatalf("migration version = %d, want 1", current)
	}

	for _, relation := range []string{"rate_limit_windows", "run_start_idempotency", "run_wakeups"} {
		var found bool
		if err := db.QueryRowContext(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, relation).Scan(&found); err != nil {
			t.Fatalf("inspect relation %s: %v", relation, err)
		}
		if !found {
			t.Errorf("current relation %s is missing", relation)
		}
	}

	var obsoleteCount int
	unsupportedPrefix := strings.Join([]string{"go", "pilot"}, "_") + "%"
	if err := db.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM pg_namespace WHERE nspname = 'drizzle') +
			(SELECT count(*) FROM information_schema.tables
			 WHERE table_schema = 'public' AND table_name LIKE $1)
	`, unsupportedPrefix).Scan(&obsoleteCount); err != nil {
		t.Fatalf("inspect unsupported schema objects: %v", err)
	}
	if obsoleteCount != 0 {
		t.Fatalf("fresh database contains %d unsupported schema objects", obsoleteCount)
	}

	if _, err := db.ExecContext(ctx, `DROP TABLE run_wakeups`); err != nil {
		t.Fatalf("damage schema for readiness test: %v", err)
	}
	if err := AssertMigrated(ctx, dsn); err == nil || !strings.Contains(err.Error(), "run_wakeups") {
		t.Fatalf("incomplete schema must fail the boot gate explicitly: %v", err)
	}
}

func TestExistingSchemaIsNotUpgraded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	dsn := createMigrationTestDatabase(t)
	db, err := open(dsn)
	if err != nil {
		t.Fatalf("open isolated database: %v", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE runs (id text PRIMARY KEY)`); err != nil {
		_ = db.Close()
		t.Fatalf("seed incompatible schema: %v", err)
	}
	_ = db.Close()

	if err := Up(ctx, dsn); err == nil {
		t.Fatal("an existing incompatible schema must not be stamped or upgraded")
	}
}
