package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGitHubCreateIssueContract(t *testing.T) {
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "")
	ctx := context.Background()
	var gate struct {
		tool, kind, credential string
		rate                   int
	}
	var posted struct {
		url     string
		headers map[string]string
		body    map[string]any
	}
	var records []map[string]any
	deps := &IntegrationDeps{
		Gate: func(_ context.Context, tool, kind, credential string, rate int) (string, string) {
			gate.tool, gate.kind, gate.credential, gate.rate = tool, kind, credential, rate
			return "ghp-never-echo", ""
		},
		RateLimitPerMin: func(family string, fallback int) int {
			if family != "github" || fallback != 60 {
				t.Fatalf("rate family: %s %d", family, fallback)
			}
			return 17
		},
		Post: func(_ context.Context, target string, headers map[string]string, body []byte) (int, string, string) {
			posted.url, posted.headers = target, headers
			if err := json.Unmarshal(body, &posted.body); err != nil {
				t.Fatalf("request JSON: %v", err)
			}
			return 201, `{"number":42,"html_url":"https://github.com/janusly/demo/issues/42"}`, ""
		},
		Record: func(tool, credential string, ok bool, status int, message string, latency int) {
			records = append(records, map[string]any{
				"tool": tool, "credential": credential, "ok": ok,
				"status": status, "message": message, "latency": latency,
			})
		},
	}
	result := ExecuteIntegrationTool(ctx, "github.create_issue", map[string]any{
		"credential": "bot-github", "owner": "weird/owner", "repo": "weird repo",
		"title": "Incident", "body": "Details", "labels": []any{"sev-1"},
		"assignees": []string{"octocat"},
	}, deps)
	if result["ok"] != true || result["issueNumber"] != float64(42) ||
		result["url"] != "https://github.com/janusly/demo/issues/42" || result["statusCode"] != 201 {
		t.Fatalf("success envelope: %+v", result)
	}
	if gate.tool != "github.create_issue" || gate.kind != "github_token" ||
		gate.credential != "bot-github" || gate.rate != 17 {
		t.Fatalf("credential gate: %+v", gate)
	}
	if posted.url != "https://api.github.com/repos/weird%2Fowner/weird%20repo/issues" ||
		posted.headers["authorization"] != "Bearer ghp-never-echo" ||
		posted.headers["x-github-api-version"] != "2022-11-28" ||
		posted.body["title"] != "Incident" {
		t.Fatalf("request: %+v", posted)
	}
	if len(records) != 1 || records[0]["ok"] != true || records[0]["status"] != 201 {
		t.Fatalf("usage record: %+v", records)
	}

	deps.Post = func(context.Context, string, map[string]string, []byte) (int, string, string) {
		return 422, `{"message":"Validation Failed"}`, ""
	}
	failed := ExecuteIntegrationTool(ctx, "github.create_issue", map[string]any{
		"credential": "bot-github", "owner": "janusly", "repo": "demo", "title": "Incident",
	}, deps)
	if failed["ok"] != false || failed["statusCode"] != 422 || failed["error"] != "Validation Failed" ||
		strings.Contains(mustJSON(t, failed), "ghp-") {
		t.Fatalf("failure envelope: %+v", failed)
	}

	invalid := ExecuteIntegrationTool(ctx, "github.create_issue", map[string]any{
		"credential": "bot-github", "owner": "janusly", "repo": "demo", "title": "Incident",
		"labels": []any{""},
	}, deps)
	if invalid["ok"] != false || !strings.Contains(invalid["error"].(string), "requires valid") {
		t.Fatalf("invalid labels: %+v", invalid)
	}

	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://provider-simulator:4010/")
	deps.Post = func(_ context.Context, target string, _ map[string]string, _ []byte) (int, string, string) {
		if target != "http://provider-simulator:4010/github/repos/acme/incidents/issues" {
			t.Fatalf("simulator URL: %s", target)
		}
		return 201, `{"number":1}`, ""
	}
	if simulated := ExecuteIntegrationTool(ctx, "github.create_issue", map[string]any{
		"credential": "bot-github", "owner": "acme", "repo": "incidents", "title": "Local",
	}, deps); simulated["ok"] != true {
		t.Fatalf("simulator: %+v", simulated)
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

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
	for i := range 11 {
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
