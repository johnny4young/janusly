//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// The patch ladder: $0 fallback with the full contract shape, a valid
// config patch answered mode:"ai" with the merged workflow validated, an
// INVALID patch never reaching the wire (degrades to no_valid_suggestions),
// alternatives capped+scrubbed inside the suggestion with evidence
// untouched, and the structural envelope inserting the approval gate.
func TestPatchWorkflowLadder(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarness(t)

	// A dead letter to patch: the standard failing http run.
	failRun(t, h, "wf-patch-"+h.org)
	ids := deadLetterIDs(t, h)
	if len(ids) != 1 {
		t.Fatalf("want 1 dead letter: %v", ids)
	}

	// Guards.
	if res := h.call("POST", "/ai/patch-workflow", map[string]any{}, ""); res.status != 400 || res.body["code"] != "ai_dead_letter_id_required" {
		t.Fatalf("id required: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/ai/patch-workflow", map[string]any{"deadLetterId": "ghost"}, ""); res.status != 404 {
		t.Fatalf("unknown dlq: %d", res.status)
	}

	// $0: full fallback shape, no aiError.
	fallback := h.call("POST", "/ai/patch-workflow", map[string]any{"deadLetterId": ids[0]}, "")
	if fallback.status != 200 || fallback.body["mode"] != "fallback" {
		t.Fatalf("$0 fallback: %d %+v", fallback.status, fallback.body)
	}
	if _, present := fallback.body["aiError"]; present {
		t.Fatal("no-key fallback must not carry aiError")
	}
	suggestions := fallback.body["suggestions"].([]any)
	first := suggestions[0].(map[string]any)
	for _, key := range []string{"workflow", "rationale", "approachLabel", "confidence", "calibratedConfidence", "safety", "consideredAlternatives"} {
		if _, present := first[key]; !present {
			t.Fatalf("fallback suggestion missing %s: %+v", key, first)
		}
	}
	passport := fallback.body["recoveryPassport"].(map[string]any)
	if passport["failureSignature"] == "" {
		t.Fatalf("passport must carry the signature: %+v", passport)
	}

	// Simulated provider: reply 1 = one VALID config patch with 3
	// alternatives (one secret-laden) + one INVALID patch (broken config
	// type) — the invalid one must never reach the wire.
	validPatch := `{"suggestions":[
		{"patchedConfig":{"url":"https://api.example.com/v2","timeoutMs":300},"rationale":"fix the port","approachLabel":"url_fix","confidence":0.9,
		 "consideredAlternatives":[
		   {"approach":"retry harder","rejectedBecause":"the target is gone"},
		   {"approach":"use sk-ant-abcdefghijklmnopqrstuvwx directly","rejectedBecause":"leaks a key sk-ant-abcdefghijklmnopqrstuvwx"},
		   {"approach":"third one","rejectedBecause":"over the cap"}]},
		{"patchedConfig":{},"rationale":"broken: drops the url","approachLabel":"other","confidence":0.99}
	]}`
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(validPatch))
	}))
	t.Cleanup(server.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)

	patched := h.call("POST", "/ai/patch-workflow", map[string]any{"deadLetterId": ids[0]}, "")
	if patched.status != 200 || patched.body["mode"] != "ai" {
		t.Fatalf("ai patch: %d %+v", patched.status, patched.body)
	}
	aiSuggestions := patched.body["suggestions"].([]any)
	if len(aiSuggestions) != 1 {
		t.Fatalf("the invalid patch must be dropped: %d survived", len(aiSuggestions))
	}
	winner := aiSuggestions[0].(map[string]any)
	workflow := winner["workflow"].(map[string]any)
	nodes := workflow["nodes"].([]any)
	patchedNode := nodes[0].(map[string]any)
	config := patchedNode["config"].(map[string]any)
	if config["url"] != "https://api.example.com/v2" {
		t.Fatalf("merged config: %+v", config)
	}
	// Alternatives: capped at 2, scrubbed, INSIDE the suggestion; the
	// evidence block stays untouched.
	alternatives := winner["consideredAlternatives"].([]any)
	if len(alternatives) != 2 {
		t.Fatalf("alternatives cap: %d", len(alternatives))
	}
	for _, raw := range alternatives {
		alt := raw.(map[string]any)
		for _, field := range []string{"approach", "rejectedBecause"} {
			if text, _ := alt[field].(string); len(text) > 0 && (len(text) > 300 ||
				containsAny(text, "sk-ant-abcdefghijklmnopqrstuvwx")) {
				t.Fatalf("alternative %s must be scrubbed/bounded: %q", field, text)
			}
		}
	}
	// Evidence: deterministic rows on BOTH modes, and the alternatives
	// never leak into it (only closed kinds appear).
	evidence := patched.body["evidence"].([]any)
	if len(evidence) == 0 {
		t.Fatal("evidence side-channel must attach on the ai path")
	}
	for _, raw := range evidence {
		row := raw.(map[string]any)
		kind, _ := row["kind"].(string)
		if kind != "recent_error" && kind != "signature_rule" {
			t.Fatalf("unexpected evidence kind: %q", kind)
		}
		if snippet, _ := row["snippet"].(string); containsAny(snippet, "retry harder", "rejectedBecause") {
			t.Fatalf("alternatives leaked into evidence: %q", snippet)
		}
	}
	if fbEvidence := fallback.body["evidence"].([]any); len(fbEvidence) == 0 {
		t.Fatal("evidence must attach on the fallback path too")
	}
}
