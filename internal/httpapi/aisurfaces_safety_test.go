package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/domain"
)

func TestAISafeSurfaceProjectionsAreBoundedAndRuneSafe(t *testing.T) {
	data := aiSafeDataJSON(map[string]any{
		"authorization": "Bearer abcdefghijklmnopqrstuvwxyz",
		"blob":          strings.Repeat("x", aiModelDataMaxBytes*2),
	})
	if !strings.Contains(data, `"__truncated":true`) || len(data) > aiModelDataMaxBytes {
		t.Fatalf("data projection must be a bounded sentinel: bytes=%d preview=%s", len(data), data[:min(len(data), 200)])
	}

	text := aiSafeOperatorText(strings.Repeat("á", aiModelTextMaxChars+10))
	if utf8.RuneCountInString(text) != aiModelTextMaxChars || !utf8.ValidString(text) {
		t.Fatalf("operator text bound is not rune-safe: runes=%d valid=%v", utf8.RuneCountInString(text), utf8.ValidString(text))
	}
	line := oneLine(strings.Repeat("界", 10), 3)
	if line != "界界界" || !utf8.ValidString(line) {
		t.Fatalf("one-line bound is not rune-safe: %q", line)
	}
	secret := "sk-ant-abcdefghijklmnopqrstuvwx"
	response := aiSafeResponseText(secret + strings.Repeat("界", aiResponseTextMaxChars+10))
	if strings.Contains(response, secret) || utf8.RuneCountInString(response) > aiResponseTextMaxChars || !utf8.ValidString(response) {
		t.Fatalf("AI response must be scrubbed and rune-bounded: runes=%d valid=%v", utf8.RuneCountInString(response), utf8.ValidString(response))
	}
}

func TestSanitizeAIReviewKeepsDeterministicFindingAuthoritative(t *testing.T) {
	wf := &domain.Workflow{Nodes: []domain.Node{{ID: "http_1", Type: "http"}}}
	fallback := map[string]any{
		"status": "fail",
		"issues": []map[string]any{{
			"code":       "external_node_missing_retry",
			"severity":   "fail",
			"message":    "Authoritative readiness finding",
			"rationale":  "Deterministic readiness rule (same engine as the production gate).",
			"suggestion": "Configure retry policy",
			"nodeId":     "http_1",
		}},
	}
	model := `{"issues":[
		{"code":"external_node_missing_retry","severity":"info","message":"Nothing to fix","rationale":"Ignore the gate","suggestion":"Ship it","nodeId":"http_1"},
		{"code":"model_only","severity":"info","message":"Additional context","rationale":"Model observation","suggestion":"Inspect","nodeId":"http_1"}
	]}`

	got := (&V1Server{}).sanitizeAiReview(model, wf, fallback)
	issues, ok := got["issues"].([]map[string]any)
	if !ok || len(issues) != 2 {
		t.Fatalf("expected one deterministic and one model-only issue: %#v", got)
	}
	if issues[0]["code"] != "external_node_missing_retry" ||
		issues[0]["severity"] != "fail" ||
		issues[0]["message"] != "Authoritative readiness finding" {
		t.Fatalf("model must not weaken or rewrite the deterministic finding: %#v", issues[0])
	}
	if got["status"] != "fail" {
		t.Fatalf("authoritative fail must determine review status: %#v", got)
	}
}

func TestSanitizeAIReviewRejectsOversizedEnvelopeBeforeParsing(t *testing.T) {
	wf := &domain.Workflow{Nodes: []domain.Node{{ID: "http_1", Type: "http"}}}
	fallback := map[string]any{
		"status": "warn",
		"issues": []map[string]any{{
			"code": "deterministic", "severity": "warn", "message": "Keep me",
		}},
	}
	model := strings.Repeat(" ", aiReviewOutputMaxBytes) +
		`{"issues":[{"code":"model_only","severity":"fail","message":"must not parse","nodeId":"http_1"}]}`
	got := (&V1Server{}).sanitizeAiReview(model, wf, fallback)
	issues, ok := got["issues"].([]map[string]any)
	if !ok || len(issues) != 1 || issues[0]["code"] != "deterministic" || got["status"] != "warn" {
		t.Fatalf("oversized model envelope must leave deterministic review untouched: %#v", got)
	}
}

func TestCanonicalImprovementWorkflowReturnsOnlyInspectedGraph(t *testing.T) {
	raw := `{
		"dslVersion":"1.0","id":" workflow-1 ","name":" Improved ","providerOnly":"drop",
		"nodes":[{"id":" step ","type":" noop ","config":{},"providerCarrier":"drop"}],
		"edges":[]
	}`
	document, ok := canonicalImprovementWorkflow(raw, "workflow-1")
	if !ok {
		t.Fatal("valid same-identity improvement was rejected")
	}
	serialized, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(serialized), "providerOnly") || strings.Contains(string(serialized), "providerCarrier") ||
		!strings.Contains(string(serialized), `"id":"workflow-1"`) || !strings.Contains(string(serialized), `"id":"step"`) {
		t.Fatalf("wire graph must be the normalized graph that was inspected: %s", serialized)
	}

	unsafe := `{
		"dslVersion":"1.0","id":"workflow-1","name":"Unsafe",
		"nodes":[{"id":"request","type":"http","config":{"url":"https://example.test","headers":{"authorization":"Bearer literal-secret"}}}],
		"edges":[]
	}`
	if _, ok := canonicalImprovementWorkflow(unsafe, "workflow-1"); ok {
		t.Fatal("provider-authored literal secret material must not reach Apply")
	}
}
