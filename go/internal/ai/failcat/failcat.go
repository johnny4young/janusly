// The single AI failure-fixture catalog (project rule: one catalog feeds
// every consuming suite, so a new failure mode lands in ALL surfaces by
// adding one entry here). Two kinds of cases:
//
//   - Wire cases: the PROVIDER fails (status/delay/body). The chokepoint
//     must classify them into the stable AIError vocabulary — consumed by
//     the ai client suite, the /ai/generate-workflow suite, and the ai
//     node suite, each proving its own degradation contract.
//   - Reply cases: the provider answers 200 but the MODEL TEXT is hostile
//     (broken / truncated / fenced / unicode-noisy JSON). Surfaces that
//     parse replies (free-json ladder) prove repair-or-fallback per case.
//
// This package is deliberately dependency-free (net/http + time only) so
// any suite — and the dev seeder — can import it without cycles.
package failcat

import (
	"net/http"
	"time"
)

// WireCase is one provider-level failure.
type WireCase struct {
	// Name is the stable case id (also the subtest name).
	Name string
	// Status is the provider HTTP status. 0 means "dead endpoint" — the
	// consumer should point the client at an unreachable address instead
	// of serving this case.
	Status int
	// Body is the provider response body (Anthropic error envelope).
	Body string
	// DelayMs delays the response; pair with a short client timeout.
	DelayMs int
	// WantClass is the AIError class the chokepoint must produce.
	WantClass string
}

// ReplyCase is one hostile model-reply text.
type ReplyCase struct {
	Name string
	// ReplyText is the assistant text the provider returns (inside a
	// well-formed Anthropic success envelope).
	ReplyText string
	// Parseable says whether the free-json ladder must recover a JSON
	// object from this text (true → the surface stays in mode "ai";
	// false → the surface degrades to its documented fallback).
	Parseable bool
}

// SuccessEnvelope wraps assistant text in a minimal valid Anthropic
// messages response.
func SuccessEnvelope(text string) string {
	quoted := ""
	for _, r := range text {
		switch r {
		case '"':
			quoted += `\"`
		case '\\':
			quoted += `\\`
		case '\n':
			quoted += `\n`
		default:
			quoted += string(r)
		}
	}
	return `{"id":"msg_fx","type":"message","role":"assistant",` +
		`"model":"claude-haiku-4-5-20251001",` +
		`"content":[{"type":"text","text":"` + quoted + `"}],` +
		`"stop_reason":"end_turn",` +
		`"usage":{"input_tokens":12,"output_tokens":7}}`
}

// Wire returns the provider-failure catalog.
func Wire() []WireCase {
	return []WireCase{
		{Name: "auth_401", Status: 401, Body: `{"type":"error","error":{"type":"authentication_error","message":"bad key"}}`, WantClass: "auth"},
		{Name: "forbidden_403", Status: 403, Body: `{"type":"error","error":{"type":"permission_error","message":"no"}}`, WantClass: "auth"},
		{Name: "rate_limit_429", Status: 429, Body: `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`, WantClass: "rate_limit"},
		{Name: "overloaded_529", Status: 529, Body: `{"type":"error","error":{"type":"overloaded_error","message":"busy"}}`, WantClass: "overloaded"},
		{Name: "server_500", Status: 500, Body: `{"type":"error","error":{"type":"api_error","message":"boom"}}`, WantClass: "overloaded"},
		{Name: "invalid_request_400", Status: 400, Body: `{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}`, WantClass: "invalid_request"},
		// garbage_200 classifies as "network": the SDK surfaces a 200 body
		// it cannot decode as a transport-level parse failure (a broken
		// proxy in front of the provider), which is what it really is.
		{Name: "garbage_200", Status: 200, Body: `<!doctype html><p>proxy error</p>`, WantClass: "network"},
		{Name: "timeout", Status: 200, Body: SuccessEnvelope("late"), DelayMs: 2000, WantClass: "timeout"},
		{Name: "network_dead", Status: 0, WantClass: "network"},
	}
}

// Replies returns the hostile model-reply catalog.
func Replies() []ReplyCase {
	return []ReplyCase{
		{Name: "no_json", ReplyText: "I cannot produce JSON today, sorry.", Parseable: false},
		{Name: "fenced_json", ReplyText: "```json\n{\"ok\":true,\"name\":\"x\"}\n```", Parseable: true},
		{Name: "truncated_json", ReplyText: `{"name":"flujo","nodes":[{"id":"a","type":"noop"`, Parseable: true},
		{Name: "bom_and_zwsp", ReplyText: "\ufeff{\"name\":\"flu\u200bjo\",\"ok\":true}", Parseable: true},
		{Name: "prose_then_json", ReplyText: "Here is the workflow you asked for:\n{\"name\":\"x\",\"ok\":true}\nHope it helps!", Parseable: true},
	}
}

// Handler serves a wire case as an HTTP handler (Status > 0 only).
func Handler(c WireCase) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c.DelayMs > 0 {
			time.Sleep(time.Duration(c.DelayMs) * time.Millisecond)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(c.Status)
		_, _ = w.Write([]byte(c.Body))
	}
}
