//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/johnny4young/janusly/go/internal/usage"
)

func anthropicReply(text string) string {
	payload, _ := json.Marshal(map[string]any{
		"id": "msg_1", "type": "message", "role": "assistant",
		"model":       "claude-haiku-4-5-20251001",
		"content":     []map[string]any{{"type": "text", "text": text}},
		"stop_reason": "end_turn",
		"usage":       map[string]any{"input_tokens": 10, "output_tokens": 5},
	})
	return string(payload)
}

// The generation ladder end to end: the $0 path answers the deterministic
// template WITHOUT aiError (the evals skip contract), the simulated
// provider path answers mode:"ai" with the generated workflow, a broken
// draft goes through the directed repair pass, and a hard provider
// failure degrades to the template WITH the classified aiError.
func TestGenerateWorkflowLadder(t *testing.T) {
	// $0: no key.
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarness(t)
	pool := testPool(t)
	usage.SetRecorder(usage.NewDBRecorder(pool))
	t.Cleanup(func() { usage.SetRecorder(nil) })

	res := h.call("POST", "/ai/generate-workflow", map[string]any{"prompt": "Pause for human approval before publishing"}, "")
	if res.status != 200 || res.body["mode"] != "fallback" || res.body["id"] != "approval-gate" {
		t.Fatalf("$0 fallback: %d %+v", res.status, res.body)
	}
	if _, present := res.body["aiError"]; present {
		t.Fatal("no-key fallback must NOT carry aiError (evals skip contract)")
	}
	// The other two eval-locked templates.
	if r := h.call("POST", "/ai/generate-workflow", map[string]any{"prompt": "Fetch a webhook URL and summarize the response with AI"}, ""); r.body["id"] != "http-ai-summary" {
		t.Fatalf("http-ai-summary template: %+v", r.body["id"])
	}
	if r := h.call("POST", "/ai/generate-workflow", map[string]any{"prompt": "Call an HTTP API, transform the JSON, and uppercase one field with a backend tool"}, ""); r.body["id"] != "api-transform-tool" {
		t.Fatalf("api-transform-tool template: %+v", r.body["id"])
	}

	// Prompt cap → 413 with the reference code.
	long := make([]byte, 5000)
	for i := range long {
		long[i] = 'a'
	}
	if r := h.call("POST", "/ai/generate-workflow", map[string]any{"prompt": string(long)}, ""); r.status != 413 || r.body["code"] != "ai_prompt_too_long" {
		t.Fatalf("prompt cap: %d %+v", r.status, r.body)
	}

	// Simulated provider: a valid one-shot generation → mode "ai".
	valid := `{"dslVersion":"1.0","id":"gen-1","name":"Generated","nodes":[{"id":"a","type":"noop","config":{}}],"edges":[]}`
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if calls.Load() <= 1 {
			_, _ = fmt.Fprint(w, anthropicReply("Here you go:\n```json\n"+valid+"\n```"))
			return
		}
		// Later calls (repair test): first a BROKEN draft, then the fix.
		if calls.Load() == 2 {
			broken := `{"dslVersion":"1.0","id":"gen-2","name":"Broken","nodes":[{"id":"a","type":"noop","config":{}}],"edges":[{"from":"a","to":"ghost"}]}`
			_, _ = fmt.Fprint(w, anthropicReply(broken))
			return
		}
		fixed := `{"dslVersion":"1.0","id":"gen-2","name":"Fixed","nodes":[{"id":"a","type":"noop","config":{}},{"id":"ghost","type":"noop","config":{}}],"edges":[{"from":"a","to":"ghost"}]}`
		_, _ = fmt.Fprint(w, anthropicReply(fixed))
	}))
	t.Cleanup(server.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)

	generated := h.call("POST", "/ai/generate-workflow", map[string]any{"prompt": "one noop please"}, "")
	if generated.status != 200 || generated.body["mode"] != "ai" || generated.body["id"] != "gen-1" {
		t.Fatalf("ai mode: %d %+v", generated.status, generated.body)
	}

	// Repair: draft with a dangling edge → issues fed back → fixed draft.
	repaired := h.call("POST", "/ai/generate-workflow", map[string]any{"prompt": "two noops"}, "")
	if repaired.status != 200 || repaired.body["mode"] != "ai" || repaired.body["name"] != "Fixed" {
		t.Fatalf("repair pass: %d %+v", repaired.status, repaired.body)
	}

	// Usage attribution + audits landed (simulated → zero cost).
	var usageRows int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM usage_events
		WHERE org_id = $1 AND metadata @> '{"providerSimulated":true}'`, h.org).Scan(&usageRows)
	if usageRows < 3 {
		t.Fatalf("simulated calls must record usage: %d", usageRows)
	}
	var aiAudits int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'ai.workflow.generated' AND metadata @> '{"mode":"ai"}'`, h.org).Scan(&aiAudits)
	if aiAudits != 2 {
		t.Fatalf("ai generations must audit: %d", aiAudits)
	}

	// Hard provider failure: the template comes back WITH the aiError.
	server.Close()
	degraded := h.call("POST", "/ai/generate-workflow", map[string]any{"prompt": "Pause for approval"}, "")
	if degraded.status != 200 || degraded.body["mode"] != "fallback" || degraded.body["id"] != "approval-gate" {
		t.Fatalf("degraded fallback: %d %+v", degraded.status, degraded.body)
	}
	if degraded.body["aiError"] == nil {
		t.Fatal("an attempted-and-failed LLM call must surface aiError")
	}
}
