package config

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestReaperSettingsDefaultsAndFloor(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Reaper != DefaultReaper() || cfg.Reaper.EffectiveThreshold() != time.Hour {
		t.Fatalf("defaults: %+v", cfg.Reaper)
	}
	cfg, err = Load(env(map[string]string{"JANUSLY_REAPER_THRESHOLD_MS": "10", "JANUSLY_REAPER_INTERVAL_MS": "50"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Reaper.EffectiveThreshold() != 15*time.Minute || cfg.Reaper.Interval != 50*time.Millisecond || cfg.Reaper.FloorOverridden {
		t.Fatalf("default floor: %+v", cfg.Reaper)
	}
	cfg, err = Load(env(map[string]string{"JANUSLY_REAPER_THRESHOLD_MS": "10", "JANUSLY_REAPER_THRESHOLD_FLOOR_MS": "20"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Reaper.EffectiveThreshold() != 20*time.Millisecond || !cfg.Reaper.FloorOverridden {
		t.Fatalf("explicit floor: %+v", cfg.Reaper)
	}
}

func TestReaperSettingsBoundDurationsWithoutClampingLongExecutions(t *testing.T) {
	for _, key := range []string{"JANUSLY_REAPER_INTERVAL_MS", "JANUSLY_REAPER_THRESHOLD_MS", "JANUSLY_REAPER_THRESHOLD_FLOOR_MS"} {
		for _, value := range []string{"0", "-1", "1.5", "NaN", "9223372036854775808", fmt.Sprint(maxReaperMilliseconds + 1)} {
			if _, err := Load(env(map[string]string{key: value})); err == nil || !strings.Contains(err.Error(), key) {
				t.Fatalf("accepted %s=%s: %v", key, value, err)
			}
		}
		for _, value := range []string{"1", fmt.Sprint(maxReaperMilliseconds)} {
			if _, err := Load(env(map[string]string{key: value})); err != nil {
				t.Fatalf("rejected boundary %s: %v", key, err)
			}
		}
	}
	cfg, err := Load(env(map[string]string{"JANUSLY_REAPER_THRESHOLD_MS": "172800000"}))
	if err != nil || cfg.Reaper.EffectiveThreshold() != 48*time.Hour {
		t.Fatalf("long executions must not use drill-only clamp: %+v %v", cfg.Reaper, err)
	}
	cfg, err = Load(env(map[string]string{"JANUSLY_REAPER_THRESHOLD_MS": fmt.Sprint(maxReaperMilliseconds)}))
	if err != nil || cfg.Reaper.EffectiveThreshold()+time.Second <= 0 {
		t.Fatalf("drill margin overflow: %+v %v", cfg.Reaper, err)
	}
}

func TestConfigurationErrorsNeverEchoInvalidValues(t *testing.T) {
	const secret = "postgres://operator:DO-NOT-LOG@private.invalid"
	for _, production := range []string{"development", "production"} {
		_, err := Load(env(map[string]string{
			"JANUSLY_ENV": production, "JANUSLY_PORT": secret, "JANUSLY_INTERNAL_HOST": secret,
			"JANUSLY_REAPER_THRESHOLD_MS": secret, "JANUSLY_STALLED_NODE_THRESHOLD_MINUTES": secret,
		}))
		if err == nil || strings.Contains(err.Error(), "DO-NOT-LOG") || strings.Contains(err.Error(), "private.invalid") {
			t.Fatalf("unsafe error: %v", err)
		}
		for _, key := range []string{"JANUSLY_PORT", "JANUSLY_INTERNAL_HOST", "JANUSLY_REAPER_THRESHOLD_MS", "JANUSLY_STALLED_NODE_THRESHOLD_MINUTES"} {
			if !strings.Contains(err.Error(), key) {
				t.Fatalf("missing actionable key %s: %v", key, err)
			}
		}
	}
}

func TestReaperConfigIsRestartScoped(t *testing.T) {
	values := map[string]string{"JANUSLY_REAPER_THRESHOLD_MS": "1800000"}
	before, err := Load(env(values))
	if err != nil {
		t.Fatal(err)
	}
	values["JANUSLY_REAPER_THRESHOLD_MS"] = "7200000"
	after, err := Load(env(values))
	if err != nil {
		t.Fatal(err)
	}
	if before.Reaper.EffectiveThreshold() != 30*time.Minute || after.Reaper.EffectiveThreshold() != 2*time.Hour {
		t.Fatal("configuration did not retain distinct boot snapshots")
	}
}
