package executors

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// The http.request TOOL rides the same SSRF chokepoint as the http node:
// a private target is rejected before any dial unless the explicit env
// escape hatch is set. This is executable security coverage for the
// integration-tool surface.
func TestHTTPRequestToolBlocksPrivateTargets(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "false")
	_, err := executeHTTPRequestTool(context.Background(), map[string]any{
		"url": "http://169.254.169.254/latest/meta-data/",
	})
	if err == nil || !strings.Contains(err.Error(), "private and blocked") {
		t.Fatalf("metadata endpoint must be blocked: %v", err)
	}
	_, err = executeHTTPRequestTool(context.Background(), map[string]any{
		"url": "http://127.0.0.1:9/x",
	})
	if err == nil || !strings.Contains(err.Error(), "private and blocked") {
		t.Fatalf("loopback must be blocked: %v", err)
	}
}

func TestHTTPRequestToolProjectsDeclaredJSON(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "echoedMethod": r.Method})
	}))
	defer upstream.Close()
	out, err := executeHTTPRequestTool(context.Background(), map[string]any{
		"url": upstream.URL, "method": "POST", "body": map[string]any{"ping": 1},
	})
	if err != nil {
		t.Fatalf("tool call: %v", err)
	}
	if out["statusCode"] != 200 || out["ok"] != true {
		t.Fatalf("status projection: %+v", out)
	}
	projected, ok := out["json"].(map[string]any)
	if !ok || projected["echoedMethod"] != "POST" {
		t.Fatalf("declared JSON must project additively: %+v", out)
	}
}

func TestHTTPRequestRegistryRejectsSemanticDriftBeforeEgress(t *testing.T) {
	registry := NewToolRegistry()
	for _, test := range []struct {
		name  string
		input map[string]any
		want  string
	}{
		{
			name:  "fractional timeout",
			input: map[string]any{"url": "https://example.com", "timeoutMs": 1.5},
			want:  "http.timeoutMs must be an integer",
		},
		{
			name:  "response above process ceiling",
			input: map[string]any{"url": "https://example.com", "maxResponseBytes": float64(httpMaxResponseBytes + 1)},
			want:  "http.maxResponseBytes must be an integer",
		},
		{
			name:  "invalid method token",
			input: map[string]any{"url": "https://example.com", "method": "GET\r\nX-Injected: true"},
			want:  "http.method must be a valid HTTP method token",
		},
		{
			name:  "non-string header",
			input: map[string]any{"url": "https://example.com", "headers": map[string]any{"X-Count": 2}},
			want:  `http.headers["X-Count"] must be a string`,
		},
		{
			name:  "header injection",
			input: map[string]any{"url": "https://example.com", "headers": map[string]any{"X-Trace": "safe\r\nX-Evil: true"}},
			want:  "valid bounded HTTP names and values",
		},
		{
			name:  "transport-owned header",
			input: map[string]any{"url": "https://example.com", "headers": map[string]any{"Content-Length": "2"}},
			want:  "controlled by the transport",
		},
		{
			name:  "userinfo URL",
			input: map[string]any{"url": "https://user:pass@example.com"},
			want:  "without userinfo or fragments",
		},
		{
			name:  "oversized body",
			input: map[string]any{"url": "https://example.com", "method": "POST", "body": strings.Repeat("x", 2<<20)},
			want:  "http.body exceeds",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := registry.ValidateInput("http.request", test.input); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("semantic validation = %v, want %q", err, test.want)
			}
		})
	}

	templated := map[string]any{
		"url": "{{context.input.url}}", "timeoutMs": "{{context.policy.output.timeoutMs}}",
		"body": "{{context.payload.output.body}}",
	}
	if err := registry.ValidateInput("http.request", templated); err != nil {
		t.Fatalf("save-time whole references must remain deferred: %v", err)
	}
	if err := registry.ValidateResolvedInput("http.request", templated); err == nil || !strings.Contains(err.Error(), "timeoutMs: Expected number") {
		t.Fatalf("runtime unresolved reference was accepted: %v", err)
	}
}

func TestHTTPRequestToolHonorsExplicitZeroRedirects(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	var received atomic.Int32
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(receiver.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, receiver.URL, http.StatusFound)
	}))
	t.Cleanup(redirector.Close)

	_, err := NewToolRegistry().Execute(t.Context(), "http.request", map[string]any{
		"url": redirector.URL, "maxRedirects": 0,
	})
	if err == nil || !strings.Contains(err.Error(), "redirect limit exceeded") || received.Load() != 0 {
		t.Fatalf("explicit zero redirects: err=%v receiverCalls=%d", err, received.Load())
	}
}

func TestRegisteredHTTPRequestUsesSharedBoundsAndMethodAwareDryRun(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(strings.Repeat("x", 2_048)))
	}))
	defer upstream.Close()

	registry := NewToolRegistry()
	exec := NewToolExecutor(registry, testHTTPExecutor())
	bounded := Input{
		Config:     map[string]any{"tool": "http.request", "input": map[string]any{"url": upstream.URL}},
		HTTPBounds: &HTTPBounds{TimeoutMs: 30_000, MaxResponseBytes: 1_024, MaxRedirects: 5},
	}
	output, err := exec(context.Background(), bounded)
	if err != nil {
		t.Fatalf("bounded tool envelope: %v", err)
	}
	result := output.(map[string]any)["result"].(map[string]any)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "maxResponseBytes") {
		t.Fatalf("tenant response bound was bypassed: %+v", result)
	}

	// The registry labels http.request write-capable conservatively, but the
	// shared HTTP executor refines validation replays by method: GET executes
	// for real signal while POST is skipped before egress.
	bounded.DryRun = true
	bounded.HTTPBounds.MaxResponseBytes = 4_096
	output, err = exec(context.Background(), bounded)
	if err != nil {
		t.Fatalf("dry-run GET: %v", err)
	}
	result = output.(map[string]any)["result"].(map[string]any)
	if result["ok"] != true || result["skipped"] == true || hits.Load() != 2 {
		t.Fatalf("dry-run GET must execute: result=%+v hits=%d", result, hits.Load())
	}
	bounded.Config["input"].(map[string]any)["method"] = "POST"
	output, err = exec(context.Background(), bounded)
	if err != nil {
		t.Fatalf("dry-run POST: %v", err)
	}
	result = output.(map[string]any)["result"].(map[string]any)
	if result["skipped"] != true || result["reason"] != "validation_dry_run" || hits.Load() != 2 {
		t.Fatalf("dry-run POST reached egress: result=%+v hits=%d", result, hits.Load())
	}
}

func TestForEachHTTPRequestUsesSharedTenantBounds(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 2_048)))
	}))
	defer upstream.Close()

	loop := NewLoopExecutor(NewToolRegistry(), testHTTPExecutor())
	output, err := loop(context.Background(), Input{
		Config: map[string]any{
			"mode": "for_each", "tool": "http.request", "items": []any{upstream.URL},
			"input": map[string]any{"url": "{{item}}"}, "toleratedFailureCount": float64(1),
		},
		Context:    map[string]any{},
		HTTPBounds: &HTTPBounds{TimeoutMs: 30_000, MaxResponseBytes: 1_024, MaxRedirects: 5},
	})
	if err != nil {
		t.Fatalf("bounded for_each envelope: %v", err)
	}
	result := output.(map[string]any)
	if result["failedCount"] != 1 {
		t.Fatalf("for_each tenant response bound was bypassed: %+v", result)
	}
	failures := result["failures"].([]any)
	message := ""
	if len(failures) == 1 {
		item, _ := failures[0].(map[string]any)
		failure, _ := item["error"].(map[string]any)
		message, _ = failure["message"].(string)
	}
	if len(failures) != 1 || !strings.Contains(message, "maxResponseBytes") {
		t.Fatalf("bounded failure evidence missing: %+v", failures)
	}
}

func TestHTTPRequestRequireOKPreservesMethodSpecificRetrySafety(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()

	exec := NewToolExecutor(NewToolRegistry(), testHTTPExecutor())
	for _, test := range []struct {
		method    string
		writeSide bool
	}{
		{method: "GET", writeSide: false},
		{method: "POST", writeSide: true},
	} {
		t.Run(test.method, func(t *testing.T) {
			_, err := exec(context.Background(), Input{Config: map[string]any{
				"tool": "http.request", "resultPolicy": "require_ok",
				"input": map[string]any{"url": upstream.URL, "method": test.method},
			}})
			var shape *ExecErrorShape
			if !errors.As(err, &shape) || shape.WriteSide != test.writeSide || shape.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("require_ok error = %#v, want writeSide=%v status=%d", err, test.writeSide, http.StatusServiceUnavailable)
			}
		})
	}
}
