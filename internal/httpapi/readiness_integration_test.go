//go:build integration

package httpapi

import (
	"testing"
)

func failingHTTPWorkflow(id string) map[string]any {
	return map[string]any{
		"id": id,
		"nodes": []any{map[string]any{"id": "call", "type": "http",
			"config": map[string]any{"url": "https://example.test"}}},
		"edges": []any{},
	}
}

func TestProductionGateBlocksFailLevelWorkflows(t *testing.T) {
	t.Setenv("JANUSLY_ENV", "production")
	t.Setenv("ALLOW_DEV_AUTH_HEADERS", "true")
	h := newAPIHarness(t)
	body := map[string]any{"workflow": failingHTTPWorkflow("wf-gate-" + h.org)}

	// v1 wire: enveloped 422.
	res := h.call("POST", "/v1/start", body, "")
	requireError(t, res, 422, "runs_not_production_ready", "Workflow not production-ready")

	// A pass-level workflow (with warns only) still starts: warns never block.
	warnsOnly := map[string]any{"workflow": map[string]any{
		"id":    "wf-gatewarn-" + h.org,
		"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}}
	if res := h.call("POST", "/v1/start", warnsOnly, ""); res.status != 200 {
		t.Fatalf("warn-only workflow must start: %d %+v", res.status, res.body)
	}
}

func TestProductionGateOffKeepsDevBehaviour(t *testing.T) {
	h := newAPIHarness(t)
	res := h.call("POST", "/v1/start", map[string]any{
		"workflow": failingHTTPWorkflow("wf-gateoff-" + h.org),
	}, "")
	if res.status != 200 {
		t.Fatalf("dev mode must start anything structurally valid: %d %+v", res.status, res.body)
	}
}

func TestReadinessBadgeRouteBothWires(t *testing.T) {
	h := newAPIHarness(t)
	doc := failingHTTPWorkflow("wf-badge-" + h.org)

	// v1 wire: enveloped result with status + issues.
	res := h.call("POST", "/v1/workflows/readiness", map[string]any{"workflow": doc}, "")
	requireEnvelope(t, res)
	data := res.body["data"].(map[string]any)
	if data["status"] != "fail" {
		t.Fatalf("badge status: %+v", data)
	}
	sawRetry := false
	for _, raw := range data["issues"].([]any) {
		issue := raw.(map[string]any)
		if issue["code"] == "external_node_missing_retry" && issue["severity"] == "fail" {
			sawRetry = true
			if issue["suggestion"] == nil {
				t.Fatalf("suggestion missing: %+v", issue)
			}
		}
	}
	if !sawRetry {
		t.Fatalf("retry issue missing: %+v", data["issues"])
	}

	// Legacy wire accepts the FLAT body shape (no envelope) and returns raw.
	raw := h.call("POST", "/workflows/readiness", doc, "")
	if raw.status != 200 || raw.body["status"] != "fail" || raw.body["apiVersion"] != nil {
		t.Fatalf("legacy badge: %d %+v", raw.status, raw.body)
	}

	// Structurally invalid → 200 fail with wrapped validation codes.
	invalid := h.call("POST", "/workflows/readiness", map[string]any{
		"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
		"edges": []any{map[string]any{"from": "a", "to": "ghost"}},
	}, "")
	if invalid.status != 200 || invalid.body["status"] != "fail" {
		t.Fatalf("invalid badge: %d %+v", invalid.status, invalid.body)
	}
	found := false
	for _, rawIssue := range invalid.body["issues"].([]any) {
		code := rawIssue.(map[string]any)["code"].(string)
		if len(code) > len("invalid_workflow_") && code[:len("invalid_workflow_")] == "invalid_workflow_" {
			found = true
		}
	}
	if !found {
		t.Fatalf("wrapped validation codes missing: %+v", invalid.body["issues"])
	}
}

func TestRollbackReadinessStartsOnlyAfterFirstSavedVersion(t *testing.T) {
	h := newAPIHarness(t)
	wfID := "wf-rollback-readiness-" + h.org
	doc := map[string]any{
		"id": wfID, "name": "Rollback readiness", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "step", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	hasRollbackWarning := func() bool {
		t.Helper()
		res := h.call("POST", "/workflows/readiness", map[string]any{"workflow": doc}, "")
		if res.status != 200 {
			t.Fatalf("readiness: %d %+v", res.status, res.body)
		}
		for _, raw := range res.body["issues"].([]any) {
			if raw.(map[string]any)["code"] == "workflow_missing_rollback_version" {
				return true
			}
		}
		return false
	}
	if hasRollbackWarning() {
		t.Fatal("an unsaved draft cannot truthfully claim that one version exists")
	}
	if res := h.call("POST", "/v1/workflows/save", doc, ""); res.status != 200 {
		t.Fatalf("save first version: %d %+v", res.status, res.body)
	}
	if !hasRollbackWarning() {
		t.Fatal("one saved version must warn that rollback is unavailable")
	}
	if res := h.call("POST", "/v1/workflows/save", doc, ""); res.status != 200 {
		t.Fatalf("save second version: %d %+v", res.status, res.body)
	}
	if hasRollbackWarning() {
		t.Fatal("two saved versions must satisfy rollback availability")
	}
}
