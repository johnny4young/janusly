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
