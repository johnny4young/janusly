package tools

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The signature is Stripe-shaped and deterministic over (secret, body, t).
func TestSignWebhookPayload(t *testing.T) {
	signature := SignWebhookPayload("shh", `{"a":1}`, 1700000000)
	if !strings.HasPrefix(signature, "t=1700000000,v1=") || len(signature) != len("t=1700000000,v1=")+64 {
		t.Fatalf("signature shape: %s", signature)
	}
	if signature != SignWebhookPayload("shh", `{"a":1}`, 1700000000) {
		t.Fatal("must be deterministic")
	}
	if signature == SignWebhookPayload("other", `{"a":1}`, 1700000000) {
		t.Fatal("secret must matter")
	}
}

// The envelope NEVER throws: nil deps, bad input, gate failure, transport
// failure, and non-2xx all answer {ok:false, error, latencyMs}.
func TestIntegrationEnvelopeNeverThrows(t *testing.T) {
	ctx := context.Background()
	if result := ExecuteIntegrationTool(ctx, "webhook.send", map[string]any{}, nil); result["ok"] != false {
		t.Fatalf("nil deps: %+v", result)
	}
	deps := &IntegrationDeps{
		Gate: func(context.Context, string, string, string, int) (string, string) {
			return "", "credential not found: x"
		},
		Post: func(context.Context, string, map[string]string, []byte) (int, string, string) { return 0, "", "" },
		Now:  func() time.Time { return time.Unix(1700000000, 0) },
	}
	result := ExecuteIntegrationTool(ctx, "webhook.send", map[string]any{
		"credential": "x", "url": "https://example.com", "payload": map[string]any{},
	}, deps)
	if result["ok"] != false || result["error"] != "credential not found: x" {
		t.Fatalf("gate failure envelope: %+v", result)
	}
	// Missing fields.
	if result := ExecuteIntegrationTool(ctx, "webhook.send", map[string]any{"credential": "x"}, deps); result["ok"] != false {
		t.Fatalf("missing fields: %+v", result)
	}
	// Header defenses: CRLF and the >10 cap.
	bad := map[string]any{
		"credential": "x", "url": "https://example.com", "payload": map[string]any{},
		"headers": map[string]any{"x-evil": "a\r\nb"},
	}
	if result := ExecuteIntegrationTool(ctx, "webhook.send", bad, deps); result["error"] != "invalid custom header" {
		t.Fatalf("CRLF must refuse: %+v", result)
	}
	many := map[string]any{}
	for i := 0; i < 11; i++ {
		many[strings.Repeat("h", i+1)] = "v"
	}
	bad["headers"] = many
	if result := ExecuteIntegrationTool(ctx, "webhook.send", bad, deps); result["error"] != "max 10 custom headers" {
		t.Fatalf("header cap must refuse: %+v", result)
	}
}
