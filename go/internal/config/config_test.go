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
	if cfg.Port != 4600 || cfg.InternalPort != 4601 {
		t.Fatalf("unexpected ports: %+v", cfg)
	}
	if cfg.WorkerConcurrency != 8 || cfg.PollInterval != 250*time.Millisecond {
		t.Fatalf("unexpected worker defaults: %+v", cfg)
	}
	if !cfg.WorkPlaneEnabled {
		t.Fatal("development must keep the work plane enabled by default")
	}
	if !strings.Contains(cfg.DatabaseURL, "4632/janusly_go") {
		t.Fatalf("unexpected database default: %s", cfg.DatabaseURL)
	}
}

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"JANUSLY_GO_PORT":               "4700",
		"JANUSLY_GO_WORKER_CONCURRENCY": "2",
		"JANUSLY_GO_POLL_MS":            "500",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 4700 || cfg.WorkerConcurrency != 2 || cfg.PollInterval != 500*time.Millisecond {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
}

func TestLoadRejectsOutOfRangeWithRangeInMessage(t *testing.T) {
	cases := []struct {
		name  string
		key   string
		value string
		want  string
	}{
		{"port too high", "JANUSLY_GO_PORT", "70000", "[1, 65535]"},
		{"concurrency zero", "JANUSLY_GO_WORKER_CONCURRENCY", "0", "[1, 64]"},
		{"poll below floor", "JANUSLY_GO_POLL_MS", "10", "[50, 5000]"},
		{"not a number", "JANUSLY_GO_HTTP_TIMEOUT_MS", "soon", "[1000, 600000]"},
		{"invalid work plane", "JANUSLY_GO_WORK_PLANE_ENABLED", "yes", "true or false"},
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

func TestWorkPlaneDefaultsPassiveInProductionAndRequiresExplicitActivation(t *testing.T) {
	passive, err := Load(env(map[string]string{"JANUSLY_GO_ENV": "production"}))
	if err != nil {
		t.Fatalf("load passive: %v", err)
	}
	if passive.WorkPlaneEnabled {
		t.Fatal("production shadow must default to a passive work plane")
	}

	active, err := Load(env(map[string]string{
		"JANUSLY_GO_ENV":                "production",
		"JANUSLY_GO_WORK_PLANE_ENABLED": "true",
	}))
	if err != nil {
		t.Fatalf("load active: %v", err)
	}
	if !active.WorkPlaneEnabled {
		t.Fatal("explicit production activation must enable the work plane")
	}

	developmentPassive, err := Load(env(map[string]string{"JANUSLY_GO_WORK_PLANE_ENABLED": "false"}))
	if err != nil {
		t.Fatalf("load development passive: %v", err)
	}
	if developmentPassive.WorkPlaneEnabled {
		t.Fatal("explicit passive mode must win outside production too")
	}
}

func TestLoadAggregatesEveryProblem(t *testing.T) {
	_, err := Load(env(map[string]string{
		"JANUSLY_GO_PORT":    "0",
		"JANUSLY_GO_POLL_MS": "1",
	}))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "JANUSLY_GO_PORT") || !strings.Contains(err.Error(), "JANUSLY_GO_POLL_MS") {
		t.Fatalf("expected both violations reported, got: %v", err)
	}
}

func TestLoadRejectsEqualPorts(t *testing.T) {
	_, err := Load(env(map[string]string{
		"JANUSLY_GO_PORT":          "4600",
		"JANUSLY_GO_INTERNAL_PORT": "4600",
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
		"JANUSLY_GO_WORKER_CONCURRENCY": "32",
		"JANUSLY_GO_API_POOL_SIZE":      "20",
		"JANUSLY_GO_WORKER_POOL_SIZE":   "40",
	}))
	if err != nil {
		t.Fatalf("load explicit: %v", err)
	}
	if explicit.APIPoolSize != 20 || explicit.WorkerPoolSize != 40 {
		t.Fatalf("explicit pool sizes wrong: %+v", explicit)
	}
	derived, err := Load(env(map[string]string{"JANUSLY_GO_WORKER_CONCURRENCY": "32"}))
	if err != nil {
		t.Fatalf("load derived: %v", err)
	}
	if derived.WorkerPoolSize != 34 {
		t.Fatalf("derived worker pool must scale with concurrency: %d", derived.WorkerPoolSize)
	}
}
