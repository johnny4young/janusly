package boot

import (
	"log/slog"
	"testing"
	"time"
)

func TestPoolConfigBoundsBurstConnectionLifetime(t *testing.T) {
	cfg, err := poolConfig("postgres://janusly:secret@127.0.0.1:5432/janusly", 24, PoolRoleAPI)
	if err != nil {
		t.Fatalf("pool config: %v", err)
	}
	if cfg.MaxConns != 24 {
		t.Fatalf("MaxConns = %d, want 24", cfg.MaxConns)
	}
	if cfg.MaxConnIdleTime != 5*time.Minute {
		t.Fatalf("MaxConnIdleTime = %s, want 5m", cfg.MaxConnIdleTime)
	}
	if cfg.HealthCheckPeriod != 30*time.Second {
		t.Fatalf("HealthCheckPeriod = %s, want 30s", cfg.HealthCheckPeriod)
	}
}

func TestPoolConfigRetainsConservativeFallbackSize(t *testing.T) {
	cfg, err := poolConfig("postgres://janusly:secret@127.0.0.1:5432/janusly", 0, PoolRoleWorker)
	if err != nil {
		t.Fatalf("pool config: %v", err)
	}
	if cfg.MaxConns != 10 {
		t.Fatalf("MaxConns = %d, want 10", cfg.MaxConns)
	}
}

func TestLogLevelFromEnvDefaultsToInfo(t *testing.T) {
	for name, want := range map[string]slog.Level{
		"": slog.LevelInfo, "debug": slog.LevelDebug, " WARN ": slog.LevelWarn,
		"warning": slog.LevelWarn, "error": slog.LevelError, "verbose": slog.LevelInfo,
	} {
		if got := logLevelFromEnv(name); got != want {
			t.Fatalf("%q: got %v, want %v", name, got, want)
		}
	}
}
