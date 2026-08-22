package httpapi

import (
	"reflect"
	"testing"
)

// The engine reads only the canonical retry/timeout keys; a model patch
// whose intent was "add backoff and a longer timeout" must not validate
// while silently dropping both.
func TestNormalizePatchedConfigMapsModelAliases(t *testing.T) {
	config := map[string]any{
		"url":     "http://127.0.0.1:39777/feed",
		"timeout": float64(30000),
		"retry": map[string]any{
			"maxAttempts":       float64(3),
			"initialDelayMs":    float64(1000),
			"backoffMultiplier": float64(2),
		},
	}
	normalizePatchedConfig(config)

	if config["timeoutMs"] != float64(30000) {
		t.Fatalf("timeout must become timeoutMs: %+v", config)
	}
	if _, stale := config["timeout"]; stale {
		t.Fatal("the alias must be consumed, not left behind")
	}
	retry := config["retry"].(map[string]any)
	want := map[string]any{
		"maxAttempts": float64(3),
		"delayMs":     float64(1000),
		"backoff":     "exponential",
	}
	if !reflect.DeepEqual(retry, want) {
		t.Fatalf("retry aliases must map onto the engine schema:\n got %+v\nwant %+v", retry, want)
	}
}

// Canonical keys always win over aliases, and a multiplier of one is
// fixed backoff, not exponential.
func TestNormalizePatchedConfigNeverOverridesCanonicalKeys(t *testing.T) {
	config := map[string]any{
		"timeoutMs": float64(5000),
		"timeout":   float64(99999),
		"retry": map[string]any{
			"maxAttempts":       float64(2),
			"maxRetries":        float64(9),
			"delayMs":           float64(250),
			"initialDelayMs":    float64(8888),
			"backoff":           "fixed",
			"backoffMultiplier": float64(4),
		},
	}
	normalizePatchedConfig(config)
	if config["timeoutMs"] != float64(5000) {
		t.Fatalf("canonical timeoutMs must win: %+v", config)
	}
	retry := config["retry"].(map[string]any)
	if retry["maxAttempts"] != float64(2) || retry["delayMs"] != float64(250) || retry["backoff"] != "fixed" {
		t.Fatalf("canonical retry keys must win: %+v", retry)
	}
	for _, alias := range []string{"maxRetries", "initialDelayMs", "backoffMultiplier"} {
		if _, stale := retry[alias]; stale {
			t.Fatalf("alias %s must be consumed: %+v", alias, retry)
		}
	}

	// No retry block and a fixed multiplier: nothing to do, nothing broken.
	flat := map[string]any{"url": "https://example.test"}
	normalizePatchedConfig(flat)
	if !reflect.DeepEqual(flat, map[string]any{"url": "https://example.test"}) {
		t.Fatalf("configs without aliases must pass through untouched: %+v", flat)
	}
	single := map[string]any{"retry": map[string]any{"backoffMultiplier": float64(1)}}
	normalizePatchedConfig(single)
	if single["retry"].(map[string]any)["backoff"] != "fixed" {
		t.Fatalf("multiplier of one is fixed backoff: %+v", single)
	}
}
