package grammar

import (
	"encoding/json"
	"testing"
)

// benchEventPayload approximates a realistic run-event payload: nested
// output envelopes, headers, arrays of rows — and NO sensitive keys,
// which is the overwhelmingly common case at the chokepoint.
func benchEventPayload() map[string]any {
	rows := make([]any, 20)
	for i := range rows {
		rows[i] = map[string]any{
			"id": "row-000", "status": "ok", "amount": 129.99,
			"labels": []any{"a", "b", "c"},
			"nested": map[string]any{"path": "/v1/things", "count": 42.0},
		}
	}
	return map[string]any{
		"nodeId": "fetch", "attempt": 1.0, "status": "succeeded",
		"output": map[string]any{
			"statusCode": 200.0,
			"headers": map[string]any{
				"content-type": "application/json", "cache-control": "no-store",
				"x-request-id": "req-123", "content-length": "48211",
			},
			"json": map[string]any{"data": rows, "hasMore": false, "cursor": "abc"},
			"body": `{"data":[...]} truncated preview of the body text for realism`,
		},
		"timing": map[string]any{"queuedMs": 4.0, "runMs": 181.0},
	}
}

func benchSensitivePayload() map[string]any {
	payload := benchEventPayload()
	payload["config"] = map[string]any{
		"url": "https://api.example.com", "apiKey": "sk-123",
		"headers": map[string]any{"authorization": "Bearer tok"},
	}
	return payload
}

func BenchmarkSafePersistClean(b *testing.B) {
	payload := benchEventPayload()
	b.ReportAllocs()
	for b.Loop() {
		if out := SafePersistPayload(payload, PersistOptions{}); len(out) == 0 {
			b.Fatal("empty")
		}
	}
}

func BenchmarkSafePersistSensitiveKeys(b *testing.B) {
	payload := benchSensitivePayload()
	b.ReportAllocs()
	for b.Loop() {
		if out := SafePersistPayload(payload, PersistOptions{}); len(out) == 0 {
			b.Fatal("empty")
		}
	}
}

func BenchmarkSafePersistRedactedValues(b *testing.B) {
	payload := benchEventPayload()
	secrets := []string{"sk-verysecretvalue", "tok-another"}
	b.ReportAllocs()
	for b.Loop() {
		if out := SafePersistPayload(payload, PersistOptions{RedactedValues: secrets}); len(out) == 0 {
			b.Fatal("empty")
		}
	}
}

// Guard: the COW walkers must never mutate the caller's tree.
func TestRedactionWalkersDoNotMutateInput(t *testing.T) {
	payload := benchSensitivePayload()
	before, _ := json.Marshal(payload)
	_ = SafePersistPayload(payload, PersistOptions{RedactedValues: []string{"Bearer tok"}})
	after, _ := json.Marshal(payload)
	if string(before) != string(after) {
		t.Fatal("SafePersistPayload mutated its input")
	}
}
