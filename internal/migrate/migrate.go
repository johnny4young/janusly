// Package migrate owns the complete Janusly schema lifecycle. The embedded
// PostgreSQL 18 baseline is intentionally fresh-install only: existing schemas
// from earlier runtimes are not stamped, reconciled, or upgraded.
package migrate

import (
	"context"
	"database/sql"
	"embed"
	"fmt"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed sql/*.sql
var migrations embed.FS

const versionTable = "janusly_schema_version"

const migrationLockKey int64 = 0x4a616e75736c7947 // "JanuslyG"

func open(databaseURL string) (*sql.DB, error) {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	return db, nil
}

func configure() {
	goose.SetBaseFS(migrations)
	goose.SetTableName(versionTable)
	goose.SetLogger(goose.NopLogger())
}

func acquireMigrationLock(ctx context.Context, db *sql.DB) (func(), error) {
	if _, err := db.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
		return nil, fmt.Errorf("acquire migration lock: %w", err)
	}
	return func() {
		// Up pins the pool to one physical connection, so unlock runs on the
		// same PostgreSQL session that acquired the advisory lock.
		_, _ = db.ExecContext(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrationLockKey)
	}, nil
}

// Up creates the current schema from the embedded baseline. It is idempotent
// only for databases already created by the same Janusly migration history.
func Up(ctx context.Context, databaseURL string) error {
	configure()
	db, err := open(databaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	release, err := acquireMigrationLock(ctx, db)
	if err != nil {
		return err
	}
	defer release()

	if err := goose.UpContext(ctx, db, "sql"); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	if err := assertBaseline(ctx, db); err != nil {
		return err
	}
	return nil
}

// AssertMigrated rejects an absent, stale, newer, or structurally incomplete
// schema before any API or worker starts serving.
func AssertMigrated(ctx context.Context, databaseURL string) error {
	configure()
	db, err := open(databaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	var journal sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT to_regclass($1)`, "public."+versionTable).Scan(&journal); err != nil {
		return fmt.Errorf("inspect migration journal: %w", err)
	}
	if !journal.Valid {
		return fmt.Errorf("database is not migrated: run the binary with the `migrate` subcommand first")
	}
	current, err := goose.GetDBVersionContext(ctx, db)
	if err != nil {
		return fmt.Errorf("database is not migrated: run the binary with the `migrate` subcommand first (%w)", err)
	}
	latest, err := latestEmbeddedVersion()
	if err != nil {
		return err
	}
	if current != latest {
		return fmt.Errorf("database is at migration %d but the binary embeds %d: run the matching binary's `migrate` subcommand first", current, latest)
	}
	return assertBaseline(ctx, db)
}

func assertBaseline(ctx context.Context, db *sql.DB) error {
	for _, relation := range []string{
		"public.runs",
		"public.run_nodes",
		"public.run_start_idempotency",
		"public.run_summary_memory_jobs",
		"public.run_wakeups",
		"public.rate_limit_windows",
		"public.org_digest_state",
		"public.schedule_entries",
		"public.workflows_active_search_trgm_idx",
		"public.dead_letters_recovery_search_trgm_idx",
	} {
		var found sql.NullString
		if err := db.QueryRowContext(ctx, `SELECT to_regclass($1)`, relation).Scan(&found); err != nil {
			return fmt.Errorf("inspect schema relation %s: %w", relation, err)
		}
		if !found.Valid {
			return fmt.Errorf("database schema is incomplete: relation %s is missing; reset the database and rerun migrate", relation)
		}
	}
	for _, extension := range []string{"vector", "pg_trgm"} {
		var exists bool
		if err := db.QueryRowContext(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1)`, extension).Scan(&exists); err != nil {
			return fmt.Errorf("inspect database extension %s: %w", extension, err)
		}
		if !exists {
			return fmt.Errorf("database schema is incomplete: extension %s is missing; reset the database and rerun migrate", extension)
		}
	}

	requiredColumns := []struct {
		relation string
		columns  []string
	}{
		{"run_start_idempotency", []string{"org_id", "idempotency_key", "run_id", "created_at"}},
		{"run_summary_memory_jobs", []string{"org_id", "run_id", "attempts", "next_attempt_at", "lease_token", "lease_expires_at", "completed_at"}},
		{"run_wakeups", []string{"run_node_id", "wake_at", "reason"}},
		{"rate_limit_windows", []string{"name", "key", "window_start", "count", "expires_at"}},
		{"org_digest_state", []string{"org_id", "last_sent_at", "batch_started_at", "delivered_recipients", "lease_token", "lease_expires_at", "next_attempt_at"}},
		{"organizations", []string{"id", "owner_user_id", "name", "plan"}},
		{"schedule_entries", []string{"next_fire_at"}},
		{"runs", []string{"workflow_id", "trigger_kind"}},
	}
	for _, requirement := range requiredColumns {
		for _, column := range requirement.columns {
			var exists bool
			if err := db.QueryRowContext(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
				)`, requirement.relation, column).Scan(&exists); err != nil {
				return fmt.Errorf("inspect schema column %s.%s: %w", requirement.relation, column, err)
			}
			if !exists {
				return fmt.Errorf("database schema is incomplete: column public.%s.%s is missing; reset the database and rerun migrate", requirement.relation, column)
			}
		}
	}

	var obsoleteSchema bool
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle')`).Scan(&obsoleteSchema); err != nil {
		return fmt.Errorf("inspect database namespaces: %w", err)
	}
	if obsoleteSchema {
		return fmt.Errorf("database contains an unsupported schema; reset the database and rerun migrate")
	}
	return nil
}

func latestEmbeddedVersion() (int64, error) {
	entries, err := migrations.ReadDir("sql")
	if err != nil {
		return 0, err
	}
	var latest int64
	for _, entry := range entries {
		var version int64
		if _, err := fmt.Sscanf(entry.Name(), "%d_", &version); err == nil && version > latest {
			latest = version
		}
	}
	if latest == 0 {
		return 0, fmt.Errorf("no embedded migrations found")
	}
	return latest, nil
}
