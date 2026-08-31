package config

import (
	"strings"
	"testing"
	"time"
)

func env(pairs map[string]string) func(string) string {
	return func(name string) string { return pairs[name] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 3001 || cfg.InternalPort != 9464 {
		t.Fatalf("unexpected ports: %+v", cfg)
	}
	if cfg.InternalHost != "127.0.0.1" {
		t.Fatalf("internal listener must default to loopback: %+v", cfg)
	}
	if cfg.WorkerConcurrency != 8 || cfg.PollInterval != 250*time.Millisecond {
		t.Fatalf("unexpected worker defaults: %+v", cfg)
	}
	if cfg.FeedbackMemoryWorkers != 4 || cfg.FeedbackMemoryQueueCapacity != 256 ||
		cfg.FeedbackMemoryTaskTimeout != 15*time.Second {
		t.Fatalf("unexpected feedback memory defaults: %+v", cfg)
	}
	if cfg.Production {
		t.Fatal("development defaults must not enable the production boot posture")
	}
	if !strings.Contains(cfg.DatabaseURL, "5432/janusly") {
		t.Fatalf("unexpected database default: %s", cfg.DatabaseURL)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"JANUSLY_PORT":                           "4700",
		"JANUSLY_INTERNAL_HOST":                  "0.0.0.0",
		"JANUSLY_WORKER_CONCURRENCY":             "2",
		"JANUSLY_POLL_MS":                        "500",
		"JANUSLY_FEEDBACK_MEMORY_WORKERS":        "6",
		"JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY": "512",
		"JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS":     "20000",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 4700 || cfg.InternalHost != "0.0.0.0" || cfg.WorkerConcurrency != 2 || cfg.PollInterval != 500*time.Millisecond {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
	if cfg.FeedbackMemoryWorkers != 6 || cfg.FeedbackMemoryQueueCapacity != 512 ||
		cfg.FeedbackMemoryTaskTimeout != 20*time.Second {
		t.Fatalf("feedback memory overrides not applied: %+v", cfg)
	}
}

func TestLoadRejectsOutOfRangeWithRangeInMessage(t *testing.T) {
	cases := []struct {
		name  string
		key   string
		value string
		want  string
	}{
		{"port too high", "JANUSLY_PORT", "70000", "[1, 65535]"},
		{"concurrency zero", "JANUSLY_WORKER_CONCURRENCY", "0", "[1, 64]"},
		{"poll below floor", "JANUSLY_POLL_MS", "10", "[50, 5000]"},
		{"not a number", "JANUSLY_HTTP_TIMEOUT_MS", "soon", "[1000, 600000]"},
		{"feedback workers too high", "JANUSLY_FEEDBACK_MEMORY_WORKERS", "33", "[1, 32]"},
		{"feedback queue zero", "JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY", "0", "[1, 4096]"},
		{"feedback timeout too high", "JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS", "300001", "[1000, 300000]"},
		{"invalid internal host", "JANUSLY_INTERNAL_HOST", "metrics.example.com", "127.0.0.1, 0.0.0.0, ::1, or ::"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(env(map[string]string{tc.key: tc.value}))
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.key) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("message must name the variable and its range, got: %v", err)
			}
		})
	}
}

// IPv6 loopback and wildcard are first-class: on hosts whose private
// network is IPv6-only, the IPv4 literals leave metrics unreachable.
func TestInternalHostAcceptsIPv6Binds(t *testing.T) {
	for _, host := range []string{"::1", "::"} {
		cfg, err := Load(env(map[string]string{"JANUSLY_INTERNAL_HOST": host}))
		if err != nil {
			t.Fatalf("load with JANUSLY_INTERNAL_HOST=%s: %v", host, err)
		}
		if cfg.InternalHost != host {
			t.Fatalf("internal host %q not preserved: %+v", host, cfg)
		}
	}
}

func TestProductionEnvironmentIsExplicit(t *testing.T) {
	cfg, err := Load(env(map[string]string{"JANUSLY_ENV": "production"}))
	if err != nil {
		t.Fatalf("load production: %v", err)
	}
	if !cfg.Production {
		t.Fatal("production environment must enable the production boot posture")
	}
}

func TestLoadAggregatesEveryProblem(t *testing.T) {
	_, err := Load(env(map[string]string{
		"JANUSLY_PORT":    "0",
		"JANUSLY_POLL_MS": "1",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "JANUSLY_PORT") || !strings.Contains(err.Error(), "JANUSLY_POLL_MS") {
		t.Fatalf("expected both violations reported, got: %v", err)
	}
}

func TestLoadRejectsEqualPorts(t *testing.T) {
	_, err := Load(env(map[string]string{
		"JANUSLY_PORT":          "3001",
		"JANUSLY_INTERNAL_PORT": "3001",
	}))
	if err == nil || !strings.Contains(err.Error(), "must differ") {
		t.Fatalf("expected the equal-port violation, got: %v", err)
	}
}

func TestPoolSizesDefaultAndDerive(t *testing.T) {
	cfg, err := Load(func(string) string { return "" })
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// API pool defaults to 10; the worker pool derives from concurrency so
	// every executor slot can hold a transaction plus claim + listener room.
	if cfg.APIPoolSize != 10 || cfg.WorkerPoolSize != cfg.WorkerConcurrency+2 {
		t.Fatalf("pool defaults wrong: api=%d worker=%d", cfg.APIPoolSize, cfg.WorkerPoolSize)
	}
	explicit, err := Load(env(map[string]string{
		"JANUSLY_WORKER_CONCURRENCY": "32",
		"JANUSLY_API_POOL_SIZE":      "20",
		"JANUSLY_WORKER_POOL_SIZE":   "40",
	}))
	if err != nil {
		t.Fatalf("load explicit: %v", err)
	}
	if explicit.APIPoolSize != 20 || explicit.WorkerPoolSize != 40 {
		t.Fatalf("explicit pool sizes wrong: %+v", explicit)
	}
	derived, err := Load(env(map[string]string{"JANUSLY_WORKER_CONCURRENCY": "32"}))
	if err != nil {
		t.Fatalf("load derived: %v", err)
	}
	if derived.WorkerPoolSize != 34 {
		t.Fatalf("derived worker pool must scale with concurrency: %d", derived.WorkerPoolSize)
	}
}
