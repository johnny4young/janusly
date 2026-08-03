//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// The remaining /ai/* surfaces. The $0 fallback contract is the
// backbone — every surface must answer usefully with NO provider, audit
// both paths, and clamp AI output to the closed contracts.

func TestAiSurfacesFallbackContract(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarness(t)
	pool := testPool(t)

	// Health: read-only posture probe, auth-only.
	health := h.call("GET", "/ai/health", nil, "")
	if health.status != 200 || health.body["enabled"] != false || health.body["generationMode"] != "free_json" {
		t.Fatalf("health: %d %+v", health.status, health.body)
	}

	workflow := map[string]any{
		"id": "ai-surf-1", "name": "Two step", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "a", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "b", "type": "http", "config": map[string]any{"url": "https://example.com"}},
		},
		"edges": []any{map[string]any{"from": "a", "to": "b"}},
	}

	// Explain-workflow: deterministic narration, no provider needed.
	explained := h.call("POST", "/ai/explain-workflow", map[string]any{"workflow": workflow}, "")
	if explained.status != 200 || explained.body["mode"] != "fallback" {
		t.Fatalf("explain-workflow: %d %+v", explained.status, explained.body)
	}
	if text, _ := explained.body["explanation"].(string); !strings.Contains(text, "2 nodes") {
		t.Fatalf("fallback explanation must narrate the DAG: %+v", explained.body)
	}

	// Review: the deterministic readiness engine IS the fallback review.
	reviewed := h.call("POST", "/ai/review-workflow", map[string]any{"workflow": workflow}, "")
	if reviewed.status != 200 || reviewed.body["mode"] != "fallback" {
		t.Fatalf("review: %d %+v", reviewed.status, reviewed.body)
	}
	review, _ := reviewed.body["review"].(map[string]any)
	issues, _ := review["issues"].([]any)
	if len(issues) == 0 {
		t.Fatalf("http node without retry must surface readiness issues: %+v", review)
	}
	for _, raw := range issues {
		issue := raw.(map[string]any)
		if issue["code"] == "" || issue["severity"] == "" {
			t.Fatalf("issue must carry code+severity: %+v", issue)
		}
	}

	// Review, invalid shape: the reference's explicit fail envelope.
	broken := h.call("POST", "/ai/review-workflow", map[string]any{"workflow": map[string]any{"id": "x"}}, "")
	brokenReview, _ := broken.body["review"].(map[string]any)
	if broken.status != 200 || broken.body["mode"] != "fallback" || brokenReview["status"] != "fail" {
		t.Fatalf("invalid shape review: %d %+v", broken.status, broken.body)
	}

	// Suggest-improvement: no provider → empty suggestions, original echoed.
	suggested := h.call("POST", "/ai/suggest-improvement", map[string]any{"workflow": workflow}, "")
	if suggested.status != 200 || suggested.body["mode"] != "fallback" {
		t.Fatalf("suggest: %d %+v", suggested.status, suggested.body)
	}
	if items, _ := suggested.body["suggestions"].([]any); len(items) != 0 {
		t.Fatalf("no provider must mean zero suggestions: %+v", suggested.body)
	}

	// Explain-run: the deterministic report is the fallback answer.
	started := h.call("POST", "/start", map[string]any{"workflow": map[string]any{
		"id": "ai-surf-run", "name": "One noop", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "only", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}}, "")
	if started.status != 200 {
		t.Fatalf("start: %d %+v", started.status, started.body)
	}
	runID := started.body["runId"].(string)
	h.waitRun(runID, "succeeded")
	explainedRun := h.call("POST", "/ai/explain-run", map[string]any{"runId": runID}, "")
	if explainedRun.status != 200 || explainedRun.body["mode"] != "fallback" {
		t.Fatalf("explain-run: %d %+v", explainedRun.status, explainedRun.body)
	}
	if text, _ := explainedRun.body["explanation"].(string); text == "" {
		t.Fatal("explain-run fallback must carry the deterministic report")
	}
	if _, ok := explainedRun.body["report"].(map[string]any); !ok {
		t.Fatalf("explain-run must attach the structured report: %+v", explainedRun.body)
	}
	if evidence, ok := explainedRun.body["evidence"].([]any); !ok || len(evidence) != 0 {
		t.Fatalf("a succeeded run carries empty (non-null) evidence: %+v", explainedRun.body)
	}

	// Input contract: missing runId 400, foreign run 404.
	if res := h.call("POST", "/ai/explain-run", map[string]any{}, ""); res.status != 400 {
		t.Fatalf("missing runId must 400: %d", res.status)
	}
	if res := h.call("POST", "/ai/explain-run", map[string]any{"runId": "nope"}, ""); res.status != 404 {
		t.Fatalf("unknown run must 404: %d %+v", res.status, res.body)
	}

	// Every surface audited its fallback path.
	for _, action := range []string{
		"ai.workflow.explained", "ai.workflow.reviewed",
		"ai.workflow.improvement_suggested", "ai.run.explained",
	} {
		var count int
		_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_logs
			WHERE org_id = $1 AND action = $2 AND metadata @> '{"mode":"fallback"}'`,
			h.org, action).Scan(&count)
		if count == 0 {
			t.Fatalf("fallback path must audit %s", action)
		}
	}
}

// The gates: ai.write (editor default) on all four mutations, editor RANK
// additionally required by suggest-improvement; viewers bounce with the
// permission 403 everywhere.
func TestAiSurfacesGates(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarness(t)
	pool := testPool(t)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO org_members (id, org_id, user_id, role)
		 VALUES ($1, $2, 'ai-viewer', 'viewer')`, h.org+"-viewer", h.org); err != nil {
		t.Fatalf("seed viewer: %v", err)
	}
	for _, path := range []string{
		"/ai/explain-workflow", "/ai/explain-run", "/ai/review-workflow", "/ai/suggest-improvement",
	} {
		res := h.callWithHeaders("POST", path, map[string]any{"runId": "x"}, h.org,
			map[string]string{"x-user-id": "ai-viewer"})
		if res.status != 403 {
			t.Fatalf("%s: viewer must get the permission 403, got %d %+v", path, res.status, res.body)
		}
	}
	// /ai/health stays open to every member.
	if res := h.callWithHeaders("GET", "/ai/health", nil, h.org,
		map[string]string{"x-user-id": "ai-viewer"}); res.status != 200 {
		t.Fatalf("health must be auth-only: %d", res.status)
	}
}

// AI mode through the local simulator: the model's review is clamped to
// the closed contract (fake severities and invented node ids dropped,
// deterministic readiness findings merged in), and improvement
// suggestions are validated — an invalid replacement never reaches the
// wire.
func TestAiSurfacesSimulatedAiMode(t *testing.T) {
	h := newAPIHarness(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch calls.Add(1) {
		case 1: // review: one valid issue + one bad severity + one invented node id
			_, _ = fmt.Fprint(w, anthropicReply(`{"issues":[`+
				`{"code":"missing_retry","severity":"warn","message":"http node b has no retry","rationale":"r","suggestion":"s","nodeId":"b"},`+
				`{"code":"fake","severity":"catastrophic","message":"x","rationale":"r","suggestion":"s"},`+
				`{"code":"ghost","severity":"fail","message":"x","rationale":"r","suggestion":"s","nodeId":"not-a-node"}]}`))
		default: // suggest: one valid full replacement + one structurally invalid
			valid := `{\"id\":\"ai-surf-2\",\"name\":\"Improved\",\"dslVersion\":\"1.0\",\"nodes\":[{\"id\":\"a\",\"type\":\"noop\",\"config\":{}}],\"edges\":[]}`
			invalid := `{\"id\":\"ai-surf-2\",\"nodes\":[{\"id\":\"a\",\"type\":\"noop\",\"config\":{}}],\"edges\":[{\"from\":\"a\",\"to\":\"ghost\"}]}`
			_, _ = fmt.Fprint(w, anthropicReply(`{"rationale":"tighten it","suggestions":[`+
				`{"patchedWorkflowJson":"`+invalid+`","rationale":"bad","approachLabel":"other","confidence":0.9},`+
				`{"patchedWorkflowJson":"`+valid+`","rationale":"good","approachLabel":"simplify","confidence":0.7}]}`))
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)

	workflow := map[string]any{
		"id": "ai-surf-2", "name": "Two step", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "a", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "b", "type": "http", "config": map[string]any{"url": "https://example.com"}},
		},
		"edges": []any{map[string]any{"from": "a", "to": "b"}},
	}

	reviewed := h.call("POST", "/ai/review-workflow", map[string]any{"workflow": workflow}, "")
	if reviewed.status != 200 || reviewed.body["mode"] != "ai" {
		t.Fatalf("ai review: %d %+v", reviewed.status, reviewed.body)
	}
	review, _ := reviewed.body["review"].(map[string]any)
	sawModelIssue, sawFallbackMerge := false, false
	for _, raw := range review["issues"].([]any) {
		issue := raw.(map[string]any)
		if issue["severity"] == "catastrophic" || issue["nodeId"] == "not-a-node" {
			t.Fatalf("sanitizer must drop out-of-contract issues: %+v", issue)
		}
		if issue["code"] == "missing_retry" {
			sawModelIssue = true
		}
		if issue["rationale"] == "Deterministic readiness rule (same engine as the production gate)." {
			sawFallbackMerge = true
		}
	}
	if !sawModelIssue || !sawFallbackMerge {
		t.Fatalf("review must merge model + readiness findings: model=%v merge=%v %+v",
			sawModelIssue, sawFallbackMerge, review)
	}

	suggested := h.call("POST", "/ai/suggest-improvement", map[string]any{"workflow": workflow}, "")
	if suggested.status != 200 || suggested.body["mode"] != "ai" {
		t.Fatalf("ai suggest: %d %+v", suggested.status, suggested.body)
	}
	items, _ := suggested.body["suggestions"].([]any)
	if len(items) != 1 {
		t.Fatalf("the invalid replacement must be dropped: %+v", suggested.body)
	}
	only := items[0].(map[string]any)
	if only["rationale"] != "good" {
		t.Fatalf("surviving suggestion must be the valid one: %+v", only)
	}
	if picked, _ := suggested.body["suggestedWorkflow"].(map[string]any); picked["name"] != "Improved" {
		t.Fatalf("suggestedWorkflow must be the top validated pick: %+v", suggested.body["suggestedWorkflow"])
	}
}
