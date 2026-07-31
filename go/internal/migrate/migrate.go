// Package migrate owns the pilot's schema lifecycle with goose (pure Go),
// per the 2026-07-31 ownership decision: the pilot self-migrates and no
// longer delegates to the Node repo's drizzle runner. Migrations embed in
// the binary (single-binary ops story), version bookkeeping lives in the
// pilot-owned table go_pilot_goose_version so it never collides with
// drizzle's own bookkeeping, and databases provisioned BEFORE goose
// adoption are stamped at the baseline version without re-executing it.
//
// Sync protocol (PLAN §0, ampliado): every develop sync reviews new files
// under packages/db/migrations and mirrors them here as numbered goose
// migrations. drizzle remains the schema owner for the Node repo; goose is
// the owner for the pilot's databases.
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

const versionTable = "go_pilot_goose_version"

// baselineVersion is the migration that captures the pre-goose schema.
const baselineVersion = 1

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

// hasPreGooseSchema reports a database that was provisioned before goose
// adoption: the shared schema exists but goose bookkeeping does not.
func hasPreGooseSchema(ctx context.Context, db *sql.DB) (bool, error) {
	var schemaExists, gooseExists bool
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_name = 'runs')`).Scan(&schemaExists); err != nil {
		return false, err
	}
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_name = $1)`, versionTable).Scan(&gooseExists); err != nil {
		return false, err
	}
	return schemaExists && !gooseExists, nil
}

// stampBaseline records the baseline as applied WITHOUT executing it —
// the pre-goose database already carries that exact schema.
func stampBaseline(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			id serial PRIMARY KEY,
			version_id bigint NOT NULL,
			is_applied boolean NOT NULL,
			tstamp timestamp NOT NULL DEFAULT now()
		)`, versionTable)); err != nil {
		return fmt.Errorf("create version table: %w", err)
	}
	for _, version := range []int64{0, baselineVersion} {
		if _, err := db.ExecContext(ctx, fmt.Sprintf(
			`INSERT INTO %s (version_id, is_applied) VALUES ($1, true)`, versionTable), version); err != nil {
			return fmt.Errorf("stamp version %d: %w", version, err)
		}
	}
	return nil
}

// Up brings the database to the latest embedded version. Fresh databases
// run everything including the baseline; pre-goose databases are stamped
// at the baseline first and then receive only what follows it.
func Up(ctx context.Context, databaseURL string) error {
	configure()
	db, err := open(databaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	preGoose, err := hasPreGooseSchema(ctx, db)
	if err != nil {
		return fmt.Errorf("inspect schema state: %w", err)
	}
	if preGoose {
		if err := stampBaseline(ctx, db); err != nil {
			return err
		}
	}
	if err := goose.UpContext(ctx, db, "sql"); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	return nil
}

// AssertMigrated fails when the database is behind the embedded migrations
// — the boot gate, mirroring the reference's assertMigrationsApplied
// posture: an api that would run against a stale schema refuses to start.
func AssertMigrated(ctx context.Context, databaseURL string) error {
	configure()
	db, err := open(databaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	current, err := goose.GetDBVersionContext(ctx, db)
	if err != nil {
		return fmt.Errorf("database is not migrated: run the binary with the `migrate` subcommand first (%w)", err)
	}
	latest, err := latestEmbeddedVersion()
	if err != nil {
		return err
	}
	if current < latest {
		return fmt.Errorf("database is at migration %d but the binary embeds %d: run the `migrate` subcommand first", current, latest)
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
