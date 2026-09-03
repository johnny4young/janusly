package grammar

import (
	"encoding/json"
	"strings"
	"testing"
)

type nestedPersistPlan struct {
	Headers map[string]string `json:"headers"`
	Note    string            `json:"note"`
}

type panickingJSONMarshaler struct{}

func (panickingJSONMarshaler) MarshalJSON() ([]byte, error) {
	panic("untrusted marshaler")
}

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
	if len(out) > 100 {
		t.Fatalf("bounded sentinel exceeded configured cap: %d bytes: %s", len(out), out)
	}
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

func TestBoundPersistPayloadAccountsForPreviewEscaping(t *testing.T) {
	raw, err := json.Marshal(map[string]any{
		"quoted":  strings.Repeat(`\\\"`, 600),
		"unicode": strings.Repeat("é", 600),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, capBytes := range []int{80, 100, 257, 1_000} {
		bounded := BoundPersistPayload(raw, capBytes)
		if !json.Valid(bounded) {
			t.Fatalf("cap %d returned invalid JSON: %q", capBytes, bounded)
		}
		if len(bounded) > capBytes {
			t.Fatalf("cap %d returned %d bytes: %s", capBytes, len(bounded), bounded)
		}
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

func TestSafePersistPayloadNormalizesOpaqueNestedValuesBeforeRedaction(t *testing.T) {
	const secret = "opaque-event-secret-918274"
	payload := map[string]any{
		"plan": nestedPersistPlan{
			Headers: map[string]string{"Authorization": "Bearer " + secret},
			Note:    "resolved " + secret,
		},
		"raw": json.RawMessage(`{"authorization":"Bearer raw-secret","note":"raw-secret"}`),
	}
	out := string(SafePersistPayload(payload, PersistOptions{
		RedactedValues: []string{secret, "raw-secret"},
	}))
	for _, forbidden := range []string{secret, "raw-secret", "Bearer opaque"} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("opaque nested value bypassed redaction (%q): %s", forbidden, out)
		}
	}
	var normalized map[string]any
	if err := json.Unmarshal([]byte(out), &normalized); err != nil {
		t.Fatalf("decode normalized payload: %v", err)
	}
	plan := normalized["plan"].(map[string]any)
	headers := plan["headers"].(map[string]any)
	raw := normalized["raw"].(map[string]any)
	if headers["Authorization"] != RedactedPlaceholder || raw["authorization"] != RedactedPlaceholder {
		t.Fatalf("typed struct and RawMessage keys must both be visible to redaction: %s", out)
	}
	if plan["note"] != "resolved "+RedactedPlaceholder || raw["note"] != RedactedPlaceholder {
		t.Fatalf("value redaction must traverse normalized opaque children: %s", out)
	}
}

func TestNormalizeJSONFailsClosedForCyclicAndPanickingValues(t *testing.T) {
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	for name, value := range map[string]any{
		"cyclic":           cyclic,
		"panickingMarshal": map[string]any{"nested": panickingJSONMarshaler{}},
	} {
		t.Run(name, func(t *testing.T) {
			normalized := NormalizeJSON(value)
			object, ok := normalized.(map[string]any)
			if !ok || len(object) != 0 {
				t.Fatalf("unrepresentable input must fail closed, got %#v", normalized)
			}
			if got := string(SafePersistPayload(value, PersistOptions{})); got != `{}` {
				t.Fatalf("safe persistence must remain available and empty, got %s", got)
			}
		})
	}
}
