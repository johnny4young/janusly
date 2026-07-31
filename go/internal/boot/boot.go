// Package boot wires the process foundations: structured logging, the pgx
// pool, and the migration probe that refuses to serve against an unmigrated
// database. The Go binary never migrates — drizzle-kit owns the schema — so
// the probe is the contract that keeps that boundary honest.
package boot

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewLogger returns the process-wide structured logger: JSON on stdout, so
// any log collector (or a human with jq) consumes it without configuration.
func NewLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, nil))
}

// Connect opens a bounded pgx pool and verifies connectivity with one ping,
// so a wrong DSN fails at startup instead of on the first query. Size it to
// the caller's role: API pools serve request handlers, worker pools serve
// claim/completion transactions — separating them keeps pollers from
// starving executors (the load tests' 50-VU cliff).
func Connect(ctx context.Context, databaseURL string, maxConns int) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if maxConns < 1 {
		maxConns = 10
	}
	cfg.MaxConns = int32(maxConns)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// ErrNotMigrated reports a database without the shared migration journal.
var ErrNotMigrated = errors.New(
	"database is not migrated: drizzle.__drizzle_migrations is missing or empty; run `make migrate`",
)

// ProbeMigrations fails fast when the shared drizzle migrations have not been
// applied, before any server starts accepting traffic.
func ProbeMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	var count int
	err := pool.QueryRow(ctx, "select count(*) from drizzle.__drizzle_migrations").Scan(&count)
	if err != nil {
		return fmt.Errorf("%w (probe query failed: %v)", ErrNotMigrated, err)
	}
	if count == 0 {
		return ErrNotMigrated
	}
	return nil
}
