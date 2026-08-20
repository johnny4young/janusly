// Package config loads and validates the process configuration from
// environment variables. Every knob has a safe default and a bounded range;
// an invalid value aborts startup with a message naming the variable and its
// accepted range, because a half-configured engine is worse than none.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the validated process configuration.
type Config struct {
	// Production enables the fail-closed boot posture for authentication,
	// external integrations, and immutable build provenance.
	Production bool
	// DatabaseURL points at the PostgreSQL database owned by Janusly.
	DatabaseURL string
	// Port serves the public API.
	Port int
	// InternalPort serves Prometheus metrics and pprof; never exposed publicly.
	InternalPort int
	// InternalHost is loopback unless an operator explicitly opens the
	// metrics/pprof listener to a private collector network.
	InternalHost string
	// WorkerConcurrency bounds the executor goroutine pool.
	WorkerConcurrency int
	// APIPoolSize bounds the API-side pgx pool; the worker pool is separate
	// so status pollers can never starve executor transactions.
	APIPoolSize int
	// WorkerPoolSize bounds the worker-side pgx pool. Zero means derive:
	// concurrency + 2 (claims + completion transactions + the listener).
	WorkerPoolSize int
	// PollInterval is the queue's fallback poll cadence when no notification
	// arrives; LISTEN/NOTIFY remains the primary wake-up signal.
	PollInterval time.Duration
	// HTTPTimeout bounds outbound http executor calls.
	HTTPTimeout time.Duration
}

// IsProduction is the single process-environment gate for production-only
// security and readiness behavior. No alternate configuration names are
// accepted by the clean runtime baseline.
func IsProduction(getenv func(string) string) bool {
	if getenv == nil {
		getenv = os.Getenv
	}
	return strings.EqualFold(strings.TrimSpace(getenv("JANUSLY_ENV")), "production")
}

// defaultDatabaseURL matches the compose project in this directory.
const defaultDatabaseURL = "postgres://janusly:janusly-local@127.0.0.1:5432/janusly"

// Load reads configuration through getenv (nil means os.Getenv, injectable
// for tests) and aggregates every violation into one error so a broken
// deployment learns all its problems at once.
func Load(getenv func(string) string) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	var problems []string

	str := func(name, def string) string {
		if v := strings.TrimSpace(getenv(name)); v != "" {
			return v
		}
		return def
	}
	num := func(name string, def, min, max int) int {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			return def
		}
		v, err := strconv.Atoi(raw)
		if err != nil || v < min || v > max {
			problems = append(problems, fmt.Sprintf("%s must be an integer in [%d, %d], got %q", name, min, max, raw))
			return def
		}
		return v
	}
	production := IsProduction(getenv)

	cfg := Config{
		Production:        production,
		DatabaseURL:       str("JANUSLY_DATABASE_URL", defaultDatabaseURL),
		Port:              num("JANUSLY_PORT", 3001, 1, 65535),
		InternalPort:      num("JANUSLY_INTERNAL_PORT", 9464, 1, 65535),
		InternalHost:      str("JANUSLY_INTERNAL_HOST", "127.0.0.1"),
		WorkerConcurrency: num("JANUSLY_WORKER_CONCURRENCY", 8, 1, 64),
		APIPoolSize:       num("JANUSLY_API_POOL_SIZE", 10, 1, 100),
		WorkerPoolSize:    num("JANUSLY_WORKER_POOL_SIZE", 0, 0, 100),
		PollInterval:      time.Duration(num("JANUSLY_POLL_MS", 250, 50, 5000)) * time.Millisecond,
		HTTPTimeout:       time.Duration(num("JANUSLY_HTTP_TIMEOUT_MS", 30_000, 1000, 600_000)) * time.Millisecond,
	}
	if cfg.WorkerPoolSize == 0 {
		cfg.WorkerPoolSize = cfg.WorkerConcurrency + 2
	}
	if cfg.Port == cfg.InternalPort {
		problems = append(problems, "JANUSLY_PORT and JANUSLY_INTERNAL_PORT must differ")
	}
	switch cfg.InternalHost {
	case "127.0.0.1", "0.0.0.0", "::1", "::":
		// Loopback or wildcard, IPv4 or IPv6. IPv6 matters on hosts whose
		// private network is IPv6-only (for example Railway); anything else
		// would silently change which peers can reach pprof and metrics.
	default:
		problems = append(problems, fmt.Sprintf(
			"JANUSLY_INTERNAL_HOST must be 127.0.0.1, 0.0.0.0, ::1, or ::, got %q", cfg.InternalHost))
	}
	if len(problems) > 0 {
		return Config{}, fmt.Errorf("invalid configuration: %s", strings.Join(problems, "; "))
	}
	return cfg, nil
}
