package config

import (
	"math"
	"strconv"
	"strings"
	"testing"
)

func TestPersistMaxBytesConfiguration(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int
	}{{"", 256000}, {" ", 256000}, {" 100 ", 100}, {"2", 2}, {strconv.Itoa(math.MaxInt), math.MaxInt}} {
		cfg, err := Load(func(key string) string {
			if key == "JANUSLY_PERSIST_MAX_BYTES" {
				return tc.raw
			}
			return ""
		})
		if err != nil || cfg.PersistMaxBytes != tc.want {
			t.Fatalf("value=%q cap=%d err=%v", tc.raw, cfg.PersistMaxBytes, err)
		}
	}
	for _, raw := range []string{"0", "1", "-1", "2.5", "1e3", "NaN", "Infinity", "9223372036854775808", "persist-SECRET"} {
		_, err := Load(func(key string) string {
			if key == "JANUSLY_PERSIST_MAX_BYTES" {
				return raw
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "JANUSLY_PERSIST_MAX_BYTES") || strings.Contains(err.Error(), "SECRET") {
			t.Fatalf("expected redacted rejection for %q: %v", raw, err)
		}
	}
}
