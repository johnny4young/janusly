package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestIntegrationChokepointValidatesInputBeforeCredentialOrEgress(t *testing.T) {
	gateCalled := false
	postCalled := false
	deps := &IntegrationDeps{
		Gate: func(context.Context, string, string, string, int) (string, string) {
			gateCalled = true
			return "secret", ""
		},
		Post: func(context.Context, string, map[string]string, []byte) (int, string, string) {
			postCalled = true
			return 200, `{}`, ""
		},
	}
	result := ExecuteIntegrationTool(context.Background(), "slack.post", map[string]any{
		"credential": false, "text": "hello",
	}, deps)
	if result["ok"] != false || gateCalled || postCalled ||
		!strings.Contains(result["error"].(string), "credential: Expected string") {
		t.Fatalf("invalid input crossed the integration boundary: %+v gate=%v post=%v", result, gateCalled, postCalled)
	}
}

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
		"credential": "bot-github", "owner": "weird-owner", "repo": "weird.repo",
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
	if posted.url != "https://api.github.com/repos/weird-owner/weird.repo/issues" ||
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
	if invalid["ok"] != false || !strings.Contains(invalid["error"].(string), "labels entries") {
		t.Fatalf("invalid labels: %+v", invalid)
	}

	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
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

func TestSlackPostContract(t *testing.T) {
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "")
	ctx := context.Background()
	hookURL := "https://hooks.slack.com/services/T00/B00/secret-token"
	postCalls := 0
	var posted map[string]any
	var recorded []map[string]any
	deps := &IntegrationDeps{
		Gate: func(_ context.Context, tool, kind, credential string, rate int) (string, string) {
			if tool != "slack.post" || kind != "slack_webhook" || credential != "incidents-slack" || rate != 19 {
				t.Fatalf("gate: %s %s %s %d", tool, kind, credential, rate)
			}
			return hookURL, ""
		},
		RateLimitPerMin: func(family string, fallback int) int {
			if family != "slack" || fallback != 60 {
				t.Fatalf("rate family: %s %d", family, fallback)
			}
			return 19
		},
		Post: func(_ context.Context, target string, headers map[string]string, body []byte) (int, string, string) {
			postCalls++
			if target != hookURL || headers["content-type"] != "application/json" {
				t.Fatalf("post target: %s %+v", target, headers)
			}
			if err := json.Unmarshal(body, &posted); err != nil {
				t.Fatal(err)
			}
			return 200, "ok", ""
		},
		Record: func(tool, credential string, ok bool, status int, message string, latency int) {
			recorded = append(recorded, map[string]any{
				"tool": tool, "credential": credential, "ok": ok,
				"status": status, "message": message, "latency": latency,
			})
		},
	}
	result := ExecuteIntegrationTool(ctx, "slack.post", map[string]any{
		"credential": "incidents-slack", "text": "Incident detected.",
	}, deps)
	if result["ok"] != true || result["statusCode"] != 200 || posted["text"] != "Incident detected." ||
		postCalls != 1 || len(recorded) != 1 || recorded[0]["ok"] != true {
		t.Fatalf("success: result=%+v posted=%+v records=%+v calls=%d", result, posted, recorded, postCalls)
	}

	invalid := ExecuteIntegrationTool(ctx, "slack.post", map[string]any{
		"credential": "incidents-slack", "blocks": []any{},
	}, deps)
	if invalid["ok"] != false || !strings.Contains(invalid["error"].(string), "non-empty") || postCalls != 1 {
		t.Fatalf("empty content: %+v", invalid)
	}

	deps.Gate = func(context.Context, string, string, string, int) (string, string) {
		return "https://evil.example.com/services/secret", ""
	}
	invalidURL := ExecuteIntegrationTool(ctx, "slack.post", map[string]any{
		"credential": "incidents-slack", "text": "Hi",
	}, deps)
	if invalidURL["ok"] != false || !strings.Contains(invalidURL["error"].(string), "hooks.slack.com") || postCalls != 1 {
		t.Fatalf("invalid hook URL: %+v", invalidURL)
	}

	deps.Gate = func(context.Context, string, string, string, int) (string, string) { return hookURL, "" }
	deps.Post = func(context.Context, string, map[string]string, []byte) (int, string, string) {
		return 0, "", "redirect exposed " + hookURL
	}
	network := ExecuteIntegrationTool(ctx, "slack.post", map[string]any{
		"credential": "incidents-slack", "text": "Hi",
	}, deps)
	if network["error"] != "network error calling slack webhook" || strings.Contains(mustJSON(t, network), "secret-token") {
		t.Fatalf("network scrub: %+v", network)
	}

	deps.Post = func(context.Context, string, map[string]string, []byte) (int, string, string) {
		return 400, "invalid_payload", ""
	}
	rejected := ExecuteIntegrationTool(ctx, "slack.post", map[string]any{
		"credential": "incidents-slack", "blocks": []any{map[string]any{"type": "section"}},
	}, deps)
	if rejected["ok"] != false || rejected["statusCode"] != 400 ||
		!strings.Contains(rejected["error"].(string), "invalid_payload") {
		t.Fatalf("non-2xx: %+v", rejected)
	}

	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://provider-simulator:4010")
	deps.Gate = func(context.Context, string, string, string, int) (string, string) {
		return "http://provider-simulator:4010/slack/services/local/ops", ""
	}
	deps.Post = func(_ context.Context, target string, _ map[string]string, _ []byte) (int, string, string) {
		if target != "http://provider-simulator:4010/slack/services/local/ops" {
			t.Fatalf("simulator target: %s", target)
		}
		return 200, "ok", ""
	}
	if simulated := ExecuteIntegrationTool(ctx, "slack.post", map[string]any{
		"credential": "incidents-slack", "text": "Local page",
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
	if result := ExecuteIntegrationTool(ctx, "webhook.send", bad, deps); result["ok"] != false ||
		!strings.Contains(result["error"].(string), "valid names and values") {
		t.Fatalf("CRLF must refuse: %+v", result)
	}
	many := map[string]any{}
	for i := range 11 {
		many[strings.Repeat("h", i+1)] = "v"
	}
	bad["headers"] = many
	if result := ExecuteIntegrationTool(ctx, "webhook.send", bad, deps); result["ok"] != false ||
		!strings.Contains(result["error"].(string), "at most 10") {
		t.Fatalf("header cap must refuse: %+v", result)
	}
}

func TestIntegrationSemanticValidationStopsCredentialAndEgress(t *testing.T) {
	gateCalls := 0
	postCalls := 0
	deps := &IntegrationDeps{
		Gate: func(context.Context, string, string, string, int) (string, string) {
			gateCalls++
			return "secret", ""
		},
		Post: func(context.Context, string, map[string]string, []byte) (int, string, string) {
			postCalls++
			return 200, `{}`, ""
		},
	}

	tests := []struct {
		name    string
		tool    string
		input   map[string]any
		message string
	}{
		{
			name: "slack empty content", tool: "slack.post",
			input: map[string]any{"credential": "slack", "text": "   "}, message: "text or non-empty blocks",
		},
		{
			name: "slack oversized text", tool: "slack.post",
			input:   map[string]any{"credential": "slack", "text": strings.Repeat("x", slackTextMaxBytes+1)},
			message: "text exceeds",
		},
		{
			name: "github path traversal", tool: "github.create_issue",
			input:   map[string]any{"credential": "github", "owner": "acme/ops", "repo": "incidents", "title": "Page"},
			message: "URL-safe GitHub path segment",
		},
		{
			name: "github multiline title", tool: "github.create_issue",
			input:   map[string]any{"credential": "github", "owner": "acme", "repo": "incidents", "title": "Page\nnow"},
			message: "single-line",
		},
		{
			name: "github duplicate labels", tool: "github.create_issue",
			input:   map[string]any{"credential": "github", "owner": "acme", "repo": "incidents", "title": "Page", "labels": []string{"Sev-1", "sev-1"}},
			message: "unique case-insensitively",
		},
		{
			name: "webhook non http URL", tool: "webhook.send",
			input:   map[string]any{"credential": "webhook", "url": "file:///tmp/exfiltrate", "payload": map[string]any{}},
			message: "absolute HTTP(S) URL",
		},
		{
			name: "webhook userinfo", tool: "webhook.send",
			input:   map[string]any{"credential": "webhook", "url": "https://user:pass@example.com/hook", "payload": map[string]any{}},
			message: "absolute HTTP(S) URL",
		},
		{
			name: "webhook reserved header", tool: "webhook.send",
			input:   map[string]any{"credential": "webhook", "url": "https://example.com/hook", "payload": map[string]any{}, "headers": map[string]any{"Authorization": "secret"}},
			message: "cannot override reserved",
		},
		{
			name: "webhook duplicate header", tool: "webhook.send",
			input:   map[string]any{"credential": "webhook", "url": "https://example.com/hook", "payload": map[string]any{}, "headers": map[string]any{"X-Trace": "one", "x-trace": "two"}},
			message: "unique case-insensitively",
		},
		{
			name: "webhook signature collision", tool: "webhook.send",
			input:   map[string]any{"credential": "webhook", "url": "https://example.com/hook", "payload": map[string]any{}, "signatureHeader": "X-Signature", "headers": map[string]any{"x-signature": "forged"}},
			message: "cannot override reserved or signature",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			beforeGate, beforePost := gateCalls, postCalls
			result := ExecuteIntegrationTool(context.Background(), test.tool, test.input, deps)
			if result["ok"] != false || !strings.Contains(result["error"].(string), test.message) {
				t.Fatalf("unexpected validation envelope: %+v", result)
			}
			if gateCalls != beforeGate || postCalls != beforePost {
				t.Fatalf("invalid input crossed boundary: gate %d→%d post %d→%d", beforeGate, gateCalls, beforePost, postCalls)
			}
		})
	}
}

func TestIntegrationAuthoringAllowsMissingOrDeferredAlternatives(t *testing.T) {
	registry := NewRegistry()
	if err := registry.ValidatePartialInput("slack.post", map[string]any{"credential": "slack"}); err != nil {
		t.Fatalf("incomplete proposal should remain representable: %v", err)
	}
	if err := registry.ValidateInput("slack.post", map[string]any{
		"credential": "slack", "blocks": "{{context.compose.output.blocks}}",
	}); err != nil {
		t.Fatalf("deferred authoring binding should validate: %v", err)
	}
	if err := registry.ValidateResolvedInput("slack.post", map[string]any{
		"credential": "slack", "blocks": []map[string]any{{"type": "section"}},
	}); err != nil {
		t.Fatalf("typed runtime slice should validate: %v", err)
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
	}, deps); result["ok"] != false || !strings.Contains(result["error"].(string), "text or html is required") {
		t.Fatalf("text-or-html: %+v", result)
	}
	for name, input := range map[string]map[string]any{
		"display mailbox":     {"to": "Alice <a@b.c>", "subject": "hi", "text": "body"},
		"header injection":    {"to": "a@b.c", "subject": "hello\r\nBcc: attacker@example.com", "text": "body"},
		"empty explicit body": {"to": "a@b.c", "subject": "hi", "html": "   "},
		"unsafe metadata":     {"to": "a@b.c", "subject": "hi", "text": "body", "metadata": map[string]any{"bad key": "x"}},
	} {
		t.Run(name, func(t *testing.T) {
			before := posted.url
			invalid := ExecuteIntegrationTool(ctx, "email.send", input, deps)
			if invalid["ok"] != false || !strings.Contains(invalid["error"].(string), "Invalid tool input") {
				t.Fatalf("invalid email input: %+v", invalid)
			}
			if posted.url != before {
				t.Fatalf("invalid input reached provider: before=%q after=%q", before, posted.url)
			}
		})
	}

	// Unconfigured → noop envelope, never a throw.
	result := ExecuteIntegrationTool(ctx, "email.send", map[string]any{
		"to": "a@b.c", "subject": "hi", "text": "body",
	}, deps)
	if result["ok"] != false || result["provider"] != "noop" ||
		!strings.Contains(result["error"].(string), "Mailer not configured") {
		t.Fatalf("noop default: %+v", result)
	}

	deps.Email = func() EmailSettings { return EmailSettings{From: "Bad <from@example.com>"} }
	invalidFrom := ExecuteIntegrationTool(ctx, "email.send", map[string]any{
		"to": "a@b.c", "subject": "hi", "text": "body",
	}, deps)
	if invalidFrom["ok"] != false || !strings.Contains(invalidFrom["error"].(string), "from address is invalid") {
		t.Fatalf("invalid configured from: %+v", invalidFrom)
	}
	deps.Email = func() EmailSettings { return EmailSettings{} }

	// Explicit simulator provider delivers through the guarded Post seam.
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
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
