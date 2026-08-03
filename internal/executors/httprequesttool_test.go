package executors

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
