package config

import (
	"strings"
	"testing"
)

func TestDBToolPoolConfiguration(t *testing.T) {
	const key = "JANUSLY_DB_TOOL_MAX_PROCESS_POOLS"
	for _, production := range []string{"development", "production"} {
		for _, tc := range []struct {
			raw  string
			want int
		}{{"", 25}, {" ", 25}, {"1", 1}, {" 37 ", 37}, {"500", 500}} {
			cfg, err := Load(env(map[string]string{key: tc.raw, "JANUSLY_ENV": production}))
			if err != nil || cfg.DBToolMaxProcessPools != tc.want {
				t.Fatalf("%s %q: cap=%d err=%v", production, tc.raw, cfg.DBToolMaxProcessPools, err)
			}
		}
		for _, raw := range []string{"0", "-1", "501", "1.5", "999999999999999999999999", "PRIVATE-SECRET"} {
			_, err := Load(env(map[string]string{key: raw, "JANUSLY_ENV": production}))
			if err == nil || !strings.Contains(err.Error(), key) || !strings.Contains(err.Error(), "[1, 500]") || strings.Contains(err.Error(), "PRIVATE-SECRET") {
				t.Fatalf("unsafe/missing rejection: %v", err)
			}
		}
	}
	values := map[string]string{key: "1"}
	before, err := Load(env(values))
	if err != nil {
		t.Fatal(err)
	}
	values[key] = "2"
	after, err := Load(env(values))
	if err != nil {
		t.Fatal(err)
	}
	if before.DBToolMaxProcessPools != 1 || after.DBToolMaxProcessPools != 2 {
		t.Fatal("configuration must be a boot snapshot")
	}
}
