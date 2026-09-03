//go:build integration

package httpapi

import (
	"net/http"
	"testing"
)

// Budget policy governs paid egress, not Janusly's deterministic product.
// A tenant that removed its API key after reaching the limit must still be
// able to author, inspect, review, and prepare a manual recovery.
func TestProviderFreeFallbacksRemainAvailableAfterBudgetIsExhausted(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarness(t)
	pool := testPool(t)
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs
		(id, org_id, key, value_json, category, description, value_type) VALUES
		($1, $2, 'ai.budgetMonthlyUsd', '1', 'ai', 'test', 'number'),
		($3, $2, 'ai.budgetExceededPolicy', '"block"', 'ai', 'test', 'string')`,
		h.org+"-fallback-budget", h.org, h.org+"-fallback-policy"); err != nil {
		t.Fatalf("seed blocked budget: %v", err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO usage_events
		(id, org_id, metric, quantity, metadata)
		VALUES ($1, $2, 'llm.completion', 1, '{"costUsd":1}')`,
		h.org+"-fallback-spend", h.org); err != nil {
		t.Fatalf("seed recorded spend: %v", err)
	}

	workflow := map[string]any{
		"id": "provider-free-budget", "name": "Provider-free budget",
		"dslVersion": "1.0",
		"nodes":      []any{map[string]any{"id": "done", "type": "noop", "config": map[string]any{}}},
		"edges":      []any{},
	}
	tests := []struct {
		name string
		path string
		body map[string]any
	}{
		{name: "author", path: "/ai/generate-workflow", body: map[string]any{"prompt": "Create one noop step"}},
		{name: "explain", path: "/ai/explain-workflow", body: map[string]any{"workflow": workflow}},
		{name: "review", path: "/ai/review-workflow", body: map[string]any{"workflow": workflow}},
		{name: "improve", path: "/ai/suggest-improvement", body: map[string]any{"workflow": workflow}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := h.call(http.MethodPost, test.path, test.body, "")
			if response.status != http.StatusOK || response.body["mode"] != "fallback" {
				t.Fatalf("deterministic fallback was budget-blocked: %d %+v", response.status, response.body)
			}
		})
	}

	failRun(t, h, "wf-provider-free-patch-"+h.org)
	deadLetters := deadLetterIDs(t, h)
	if len(deadLetters) != 1 {
		t.Fatalf("want one dead letter, got %v", deadLetters)
	}
	patch := h.call(http.MethodPost, "/ai/patch-workflow", map[string]any{"deadLetterId": deadLetters[0]}, "")
	if patch.status != http.StatusOK || patch.body["mode"] != "fallback" {
		t.Fatalf("deterministic recovery fallback was budget-blocked: %d %+v", patch.status, patch.body)
	}

	feedbackID := h.org + "-fallback-feedback"
	if _, err := pool.Exec(t.Context(), `INSERT INTO recovery_feedback
		(id, org_id, user_id, dead_letter_id, workflow_id, suggestion_mode,
		 approach_label, accepted, eval_consent, comment)
		VALUES ($1, $2, 'u1', 'dl-'||$1, 'wf-provider-free-eval', 'fallback',
		 'retry', true, true, 'bounded timeout')`, feedbackID, h.org); err != nil {
		t.Fatalf("seed provider-free evaluation: %v", err)
	}
	dataset := h.call(http.MethodPost, "/eval/datasets", map[string]any{
		"name": "provider-free-budget", "workflowId": "wf-provider-free-eval",
	}, "")
	if dataset.status != http.StatusCreated {
		t.Fatalf("create provider-free dataset: %d %+v", dataset.status, dataset.body)
	}
	datasetID := dataset.body["dataset"].(map[string]any)["id"].(string)
	experiment := h.call(http.MethodPost, "/experiments/run", map[string]any{
		"name": "provider-free-budget", "kind": "model",
		"controlRef": "control", "candidateRef": "candidate",
		"evalDatasetId": datasetID, "scorerKind": "string_equality",
	}, "")
	if experiment.status != http.StatusOK {
		t.Fatalf("provider-free experiment was budget-blocked: %d %+v", experiment.status, experiment.body)
	}

	var blockedAudits int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'billing.budget.exceeded'`, h.org).Scan(&blockedAudits); err != nil {
		t.Fatalf("count budget audits: %v", err)
	}
	if blockedAudits != 0 {
		t.Fatalf("provider-free fallbacks must not be recorded as blocked model calls: %d", blockedAudits)
	}
}
