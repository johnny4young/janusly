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
	// DatabaseURL points at the pilot PostgreSQL (shared-schema database).
	DatabaseURL string
	// Port serves the public API.
	Port int
	// InternalPort serves Prometheus metrics and pprof; never exposed publicly.
	InternalPort int
	// WorkerConcurrency bounds the executor goroutine pool.
	WorkerConcurrency int
	// PollInterval is the queue's fallback poll cadence when no notification
	// arrives; LISTEN/NOTIFY remains the primary wake-up signal.
	PollInterval time.Duration
	// HTTPTimeout bounds outbound http executor calls.
	HTTPTimeout time.Duration
}

// defaultDatabaseURL matches the compose project in this directory.
const defaultDatabaseURL = "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go"

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

	cfg := Config{
		DatabaseURL:       str("JANUSLY_GO_DATABASE_URL", defaultDatabaseURL),
		Port:              num("JANUSLY_GO_PORT", 4600, 1, 65535),
		InternalPort:      num("JANUSLY_GO_INTERNAL_PORT", 4601, 1, 65535),
		WorkerConcurrency: num("JANUSLY_GO_WORKER_CONCURRENCY", 8, 1, 64),
		PollInterval:      time.Duration(num("JANUSLY_GO_POLL_MS", 250, 50, 5000)) * time.Millisecond,
		HTTPTimeout:       time.Duration(num("JANUSLY_GO_HTTP_TIMEOUT_MS", 30_000, 1000, 600_000)) * time.Millisecond,
	}
	if cfg.Port == cfg.InternalPort {
		problems = append(problems, "JANUSLY_GO_PORT and JANUSLY_GO_INTERNAL_PORT must differ")
	}
	if len(problems) > 0 {
		return Config{}, fmt.Errorf("invalid configuration: %s", strings.Join(problems, "; "))
	}
	return cfg, nil
}
