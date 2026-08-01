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

// email.send: the provider ladder resolves at call time, the noop
// default keeps the write-side fallback contract, and validation
// failures answer clean envelopes.
func TestEmailSendEnvelopes(t *testing.T) {
	ctx := context.Background()
	t.Setenv("JANUSLY_MAILER_PROVIDER", "")
	t.Setenv("RESEND_API_KEY", "")
	t.Setenv("SENDGRID_API_KEY", "")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "")

	var posted struct {
		url  string
		body string
	}
	deps := &IntegrationDeps{
		Gate: func(context.Context, string, string, string, int) (string, string) { return "", "" },
		Post: func(_ context.Context, url string, _ map[string]string, body []byte) (int, string, string) {
			posted.url, posted.body = url, string(body)
			return 200, `{"id":"msg_sim_1"}`, ""
		},
		RateLimit: func(context.Context, string, int) string { return "" },
		Email:     func() EmailSettings { return EmailSettings{} },
	}

	// Validation ladder.
	if result := ExecuteIntegrationTool(ctx, "email.send", map[string]any{"to": "a@b.c"}, deps); result["ok"] != false {
		t.Fatalf("missing subject: %+v", result)
	}
	if result := ExecuteIntegrationTool(ctx, "email.send", map[string]any{
		"to": "a@b.c", "subject": "hi",
	}, deps); result["error"] != "email.send requires `text` or `html` (or both)." {
		t.Fatalf("text-or-html: %+v", result)
	}

	// Unconfigured → noop envelope, never a throw.
	result := ExecuteIntegrationTool(ctx, "email.send", map[string]any{
		"to": "a@b.c", "subject": "hi", "text": "body",
	}, deps)
	if result["ok"] != false || result["provider"] != "noop" ||
		!strings.Contains(result["error"].(string), "Mailer not configured") {
		t.Fatalf("noop default: %+v", result)
	}

	// Explicit simulator provider delivers through the guarded Post seam.
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://sim.internal")
	t.Setenv("JANUSLY_MAILER_PROVIDER", "simulator")
	result = ExecuteIntegrationTool(ctx, "email.send", map[string]any{
		"to": "a@b.c", "subject": "hi", "text": "body",
	}, deps)
	if result["ok"] != true || result["provider"] != "simulator" || result["providerMessageId"] != "msg_sim_1" {
		t.Fatalf("simulator: %+v", result)
	}
	if posted.url != "http://sim.internal/email/send" || !strings.Contains(posted.body, `"subject":"hi"`) {
		t.Fatalf("simulator post: %+v", posted)
	}

	// Resend path: URL + bearer header + tags translation; non-2xx envelope.
	t.Setenv("JANUSLY_MAILER_PROVIDER", "resend")
	t.Setenv("RESEND_API_KEY", "re_key")
	deps.Post = func(_ context.Context, url string, headers map[string]string, body []byte) (int, string, string) {
		posted.url, posted.body = url, string(body)
		if headers["Authorization"] != "Bearer re_key" {
			t.Fatalf("resend auth header missing")
		}
		return 200, `{"id":"msg_re_1"}`, ""
	}
	result = ExecuteIntegrationTool(ctx, "email.send", map[string]any{
		"to": "a@b.c", "subject": "hi", "text": "body",
		"metadata": map[string]any{"campaign": "x"},
	}, deps)
	if result["ok"] != true || result["providerMessageId"] != "msg_re_1" ||
		posted.url != "https://api.resend.com/emails" || !strings.Contains(posted.body, `"tags"`) {
		t.Fatalf("resend: %+v %s", result, posted.body)
	}
	deps.Post = func(context.Context, string, map[string]string, []byte) (int, string, string) {
		return 422, `{"message":"invalid from"}`, ""
	}
	result = ExecuteIntegrationTool(ctx, "email.send", map[string]any{
		"to": "a@b.c", "subject": "hi", "text": "body",
	}, deps)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "Resend returned HTTP 422") {
		t.Fatalf("resend non-2xx: %+v", result)
	}

	// Rate limit converts to a clean envelope.
	deps.RateLimit = func(context.Context, string, int) string { return "Rate limit exceeded for email.send" }
	result = ExecuteIntegrationTool(ctx, "email.send", map[string]any{
		"to": "a@b.c", "subject": "hi", "text": "body",
	}, deps)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "Rate limit") {
		t.Fatalf("rate envelope: %+v", result)
	}
}
