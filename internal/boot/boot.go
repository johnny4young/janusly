// Package boot wires the process foundations: structured logging, the pgx
// pool, and the second in-process migration probe that refuses to serve after
// the command-level embedded-Goose gate has passed an unmigrated database.
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

// ErrNotMigrated reports a database behind the embedded Goose baseline.
var ErrNotMigrated = errors.New(
	"database is not migrated: run the binary's `migrate` subcommand first",
)

// ProbeMigrations fails fast when the goose journal is missing or behind,
// before any server starts accepting traffic.
func ProbeMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	var current int64
	err := pool.QueryRow(ctx,
		"SELECT COALESCE(MAX(version_id), 0) FROM janusly_schema_version WHERE is_applied").Scan(&current)
	if err != nil {
		return fmt.Errorf("%w (probe query failed: %v)", ErrNotMigrated, err)
	}
	if current == 0 {
		return ErrNotMigrated
	}
	return nil
}
