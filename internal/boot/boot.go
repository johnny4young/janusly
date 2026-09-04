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
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/observability"
)

const (
	poolMaxConnIdleTime   = 5 * time.Minute
	poolHealthCheckPeriod = 30 * time.Second
)

// PoolRole selects the PostgreSQL session limits a pool's connections carry.
type PoolRole int

const (
	// PoolRoleAPI serves request handlers: every statement is short.
	PoolRoleAPI PoolRole = iota
	// PoolRoleWorker serves claims, completions and maintenance sweeps,
	// whose batched deletes and index-backed scans may legitimately run
	// longer than any request.
	PoolRoleWorker
)

// Session limits ride every pooled connection so a runaway statement, a
// lock wait or a forgotten transaction cancels on the server instead of
// holding a connection (and its locks) until the client gives up. The
// migration connection is separate and deliberately unbounded.
const (
	apiStatementTimeout    = 15 * time.Second
	workerStatementTimeout = 60 * time.Second
	poolLockTimeout        = 5 * time.Second
	poolIdleInTxTimeout    = 30 * time.Second
)

// StatementTimeout is the per-statement bound a role's connections carry.
func (role PoolRole) StatementTimeout() time.Duration {
	if role == PoolRoleWorker {
		return workerStatementTimeout
	}
	return apiStatementTimeout
}

// NewLogger returns the process-wide structured logger: JSON on stdout, so
// any log collector (or a human with jq) consumes it without configuration.
// JANUSLY_LOG_LEVEL (debug, info, warn, error; default info) sets the floor.
func NewLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevelFromEnv(os.Getenv("JANUSLY_LOG_LEVEL"))}))
}

// logLevelFromEnv maps the configured name to a level; anything unknown or
// empty keeps info, so a typo can never silence the process.
func logLevelFromEnv(name string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Connect opens a bounded pgx pool and verifies connectivity with one ping,
// so a wrong DSN fails at startup instead of on the first query. Size it to
// the caller's role: API pools serve request handlers, worker pools serve
// claim/completion transactions — separating them keeps pollers from
// starving executors (the load tests' 50-VU cliff).
func Connect(ctx context.Context, databaseURL string, maxConns int, role PoolRole) (*pgxpool.Pool, error) {
	cfg, err := poolConfig(databaseURL, maxConns, role)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
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

func poolConfig(databaseURL string, maxConns int, role PoolRole) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = milliseconds(role.StatementTimeout())
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = milliseconds(poolLockTimeout)
	cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = milliseconds(poolIdleInTxTimeout)
	// One client span per statement, named after the sqlc query; a no-op
	// until a trace provider is configured.
	cfg.ConnConfig.Tracer = observability.NewPgxTracer()
	if maxConns < 1 {
		maxConns = 10
	}
	cfg.MaxConns = int32(maxConns)
	// pgx defaults idle connections to 30 minutes. After a short traffic
	// spike that keeps two whole process pools unnecessarily expanded. A
	// five-minute idle window preserves reuse while a frequent health check
	// returns burst capacity before the local six-minute soak settle ends.
	cfg.MaxConnIdleTime = poolMaxConnIdleTime
	cfg.HealthCheckPeriod = poolHealthCheckPeriod
	return cfg, nil
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

func milliseconds(d time.Duration) string {
	return strconv.FormatInt(d.Milliseconds(), 10)
}
