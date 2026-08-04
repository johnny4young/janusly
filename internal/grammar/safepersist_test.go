package grammar

import (
	"encoding/json"
	"strings"
	"testing"
)

// The three-layer stack: value redaction (optional), key redaction
// (always), size bounding (default / env / per-call / unbounded).
func TestSafePersistPayloadLayers(t *testing.T) {
	payload := map[string]any{
		"note":   "the token is sk-live-999 and that is bad",
		"apiKey": "sk-live-999",
		"nested": map[string]any{"password_hash": "hunter2", "ok": "visible"},
	}
	out := string(SafePersistPayload(payload, PersistOptions{
		RedactedValues: []string{"sk-live-999"},
	}))
	if strings.Contains(out, "sk-live-999") || strings.Contains(out, "hunter2") {
		t.Fatalf("secrets survived: %s", out)
	}
	if !strings.Contains(out, `"note":"the token is [redacted] and that is bad"`) {
		t.Fatalf("value layer must scrub string occurrences: %s", out)
	}
	if !strings.Contains(out, `"ok":"visible"`) {
		t.Fatalf("non-sensitive content must survive: %s", out)
	}
}

func TestSafePersistPayloadEnvOverride(t *testing.T) {
	t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "100")
	out := SafePersistPayload(map[string]any{"blob": strings.Repeat("x", 500)}, PersistOptions{})
	var sentinel struct {
		Truncated bool `json:"__truncated"`
		MaxBytes  int  `json:"maxBytes"`
	}
	if err := json.Unmarshal(out, &sentinel); err != nil || !sentinel.Truncated || sentinel.MaxBytes != 100 {
		t.Fatalf("env cap must apply: %s (%v)", out, err)
	}

	// A malformed override falls back to the contract default.
	t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "not-a-number")
	if DefaultPersistMaxBytes() != 256_000 {
		t.Fatalf("malformed env must fall back: %d", DefaultPersistMaxBytes())
	}
}

func TestSafePersistPayloadUnbounded(t *testing.T) {
	out := SafePersistPayload(map[string]any{
		"blob": strings.Repeat("x", 600_000), "authorization": "Bearer abc",
	}, PersistOptions{MaxBytes: PersistUnbounded})
	if strings.Contains(string(out), "__truncated") {
		t.Fatal("unbounded must never truncate")
	}
	if !strings.Contains(string(out), `"authorization":"[redacted]"`) {
		t.Fatal("unbounded still key-redacts")
	}
}
