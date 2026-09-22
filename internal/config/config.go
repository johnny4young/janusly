// Package config loads and validates the process configuration from
// environment variables. Every knob has a safe default and a bounded range;
// an invalid value aborts startup with a message naming the variable and its
// accepted range, because a half-configured engine is worse than none.
package config

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/orgconfig"
)

// DefaultDBToolMaxProcessPools is the external tools' default physical pool budget.
const DefaultDBToolMaxProcessPools = 25

// MaxDBToolProcessPools is the largest supported process pool budget.
const MaxDBToolProcessPools = 500

// Config is the validated process configuration.
type Config struct {
	// PersistMaxBytes bounds default event and audit serialization.
	PersistMaxBytes int
	// DBToolMaxProcessPools bounds live external tool pools, including retired leases.
	DBToolMaxProcessPools int
	Reaper                Reaper

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
	// FeedbackMemoryWorkers bounds optional feedback-derived memory commits.
	FeedbackMemoryWorkers int
	// FeedbackMemoryQueueCapacity bounds accepted tasks waiting for workers;
	// saturation drops only the optional memory side effect.
	FeedbackMemoryQueueCapacity int
	// FeedbackMemoryTaskTimeout bounds one feedback-derived memory task.
	FeedbackMemoryTaskTimeout time.Duration
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
const defaultDatabaseURL = "postgres://janusly:janusly-local@127.0.0.1:15473/janusly"

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
	integer := func(name string, def, min, max int64) int64 {
		raw := strings.TrimSpace(getenv(name))
		if raw == "" {
			return def
		}
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < min || v > max {
			problems = append(problems, fmt.Sprintf("%s must be an integer in [%d, %d]", name, min, max))
			return def
		}
		return v
	}
	num := func(name string, def, min, max int) int {
		return int(integer(name, int64(def), int64(min), int64(max)))
	}
	production := IsProduction(getenv)
	reaperDefaults := DefaultReaper()

	cfg := Config{
		PersistMaxBytes:       num("JANUSLY_PERSIST_MAX_BYTES", grammar.DefaultPersistMaxBytes, 2, math.MaxInt),
		DBToolMaxProcessPools: num("JANUSLY_DB_TOOL_MAX_PROCESS_POOLS", DefaultDBToolMaxProcessPools, 1, MaxDBToolProcessPools),
		Reaper: Reaper{
			Interval:        time.Duration(integer("JANUSLY_REAPER_INTERVAL_MS", int64(reaperDefaults.Interval/time.Millisecond), 1, maxReaperMilliseconds)) * time.Millisecond,
			Threshold:       time.Duration(integer("JANUSLY_REAPER_THRESHOLD_MS", int64(reaperDefaults.Threshold/time.Millisecond), 1, maxReaperMilliseconds)) * time.Millisecond,
			Floor:           time.Duration(integer("JANUSLY_REAPER_THRESHOLD_FLOOR_MS", int64(reaperDefaults.Floor/time.Millisecond), 1, maxReaperMilliseconds)) * time.Millisecond,
			FloorOverridden: strings.TrimSpace(getenv("JANUSLY_REAPER_THRESHOLD_FLOOR_MS")) != "",
		},
		Production:                  production,
		DatabaseURL:                 str("JANUSLY_DATABASE_URL", defaultDatabaseURL),
		Port:                        num("JANUSLY_PORT", 3001, 1, 65535),
		InternalPort:                num("JANUSLY_INTERNAL_PORT", 9464, 1, 65535),
		InternalHost:                str("JANUSLY_INTERNAL_HOST", "127.0.0.1"),
		WorkerConcurrency:           num("JANUSLY_WORKER_CONCURRENCY", 8, 1, 64),
		APIPoolSize:                 num("JANUSLY_API_POOL_SIZE", 10, 1, 100),
		WorkerPoolSize:              num("JANUSLY_WORKER_POOL_SIZE", 0, 0, 100),
		PollInterval:                time.Duration(num("JANUSLY_POLL_MS", 250, 50, 5000)) * time.Millisecond,
		FeedbackMemoryWorkers:       num("JANUSLY_FEEDBACK_MEMORY_WORKERS", 4, 1, 32),
		FeedbackMemoryQueueCapacity: num("JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY", 256, 1, 4096),
		FeedbackMemoryTaskTimeout: time.Duration(num(
			"JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS", 15_000, 1000, 300_000,
		)) * time.Millisecond,
	}
	if strings.TrimSpace(getenv("JANUSLY_STALLED_NODE_THRESHOLD_MINUTES")) != "" {
		problems = append(problems, "JANUSLY_STALLED_NODE_THRESHOLD_MINUTES is unsupported; use JANUSLY_REAPER_THRESHOLD_MS")
	}
	if cfg.WorkerPoolSize == 0 {
		cfg.WorkerPoolSize = cfg.WorkerConcurrency + 2
	}
	if cfg.Port == cfg.InternalPort {
		problems = append(problems, "JANUSLY_PORT and JANUSLY_INTERNAL_PORT must differ")
	}
	if production {
		for _, name := range []string{"JANUSLY_LOCAL_STACK", "JANUSLY_LOCAL_INTEGRATION_SIMULATOR"} {
			if getenv(name) == "true" {
				problems = append(problems, name+" must not be enabled when JANUSLY_ENV=production")
			}
		}
	}
	switch cfg.InternalHost {
	case "127.0.0.1", "0.0.0.0", "::1", "::":
		// Loopback or wildcard, IPv4 or IPv6. IPv6 matters on hosts whose
		// private network is IPv6-only (for example Railway); anything else
		// would silently change which peers can reach pprof and metrics.
	default:
		problems = append(problems, "JANUSLY_INTERNAL_HOST must be 127.0.0.1, 0.0.0.0, ::1, or ::")
	}
	problems = append(problems, orgconfig.ValidateHTTPEnvironment(getenv)...)
	if len(problems) > 0 {
		return Config{}, fmt.Errorf("invalid configuration: %s", strings.Join(problems, "; "))
	}
	return cfg, nil
}
