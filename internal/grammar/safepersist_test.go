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

func TestPersisterCapturesIndependentDefaults(t *testing.T) {
	first, err := NewPersister(100)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewPersister(300)
	if err != nil {
		t.Fatal(err)
	}
	copied := first
	first = second
	t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "2")
	payload := map[string]any{"blob": strings.Repeat("x", 500)}
	for _, tc := range []struct {
		policy Persister
		want   int
	}{{copied, 100}, {second, 300}, {first, 300}, {Persister{}, 256000}} {
		out := tc.policy.Payload(payload, PersistOptions{})
		if tc.policy.MaxBytes() != tc.want || len(out) > tc.want || !json.Valid(out) {
			t.Fatalf("cap %d: %s", tc.want, out)
		}
		if tc.want < 500 && !strings.Contains(string(out), `"__truncated":true`) {
			t.Fatalf("missing sentinel: %s", out)
		}
	}
	// The pure helper also stays deterministic; process overrides require injection.
	if out := SafePersistPayload(payload, PersistOptions{}); strings.Contains(string(out), "__truncated") {
		t.Fatalf("environment affected pure helper: %s", out)
	}
}

func TestPersisterBoundsAndOverrides(t *testing.T) {
	for _, cap := range []int{-1, 0, 1} {
		if _, err := NewPersister(cap); err == nil {
			t.Fatalf("accepted cap %d", cap)
		}
	}
	for _, cap := range []int{2, 19, 100, 256000} {
		p, err := NewPersister(cap)
		if err != nil {
			t.Fatal(err)
		}
		out := p.Payload(map[string]any{"text": strings.Repeat("é\\\"", 100000)}, PersistOptions{})
		if len(out) > cap || !json.Valid(out) {
			t.Fatalf("cap %d returned %d invalid/bounded bytes", cap, len(out))
		}
	}
	p, err := NewPersister(2)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"note": "resolved-secret", "authorization": "key-secret", "text": strings.Repeat("x", 500)}
	for _, cap := range []int{200, PersistUnbounded} {
		out := p.Payload(payload, PersistOptions{MaxBytes: cap, RedactedValues: []string{"resolved-secret"}})
		if strings.Contains(string(out), "resolved-secret") || strings.Contains(string(out), "key-secret") {
			t.Fatalf("secret survived: %s", out)
		}
		if cap > 0 && (len(out) > cap || !strings.Contains(string(out), "__truncated")) {
			t.Fatalf("explicit cap ignored: %s", out)
		}
		if cap < 0 && (len(out) < 500 || strings.Contains(string(out), "__truncated")) {
			t.Fatalf("unbounded override ignored: %s", out)
		}
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
