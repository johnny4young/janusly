//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/engine"
)

// The healing proposal may come from the LLM behind the org opt-in + budget
// gate, but only through the closed retry/timeout patch grammar. Sandbox
// validation remains unchanged and every degradation keeps the deterministic
// harden_retries proposal.

// healingFixture seeds an opted-in org with a same-signature DLQ cluster
// (two failed runs against a flaky endpoint) and returns the flaky server
// call counter so tests can flip it to success for validation replays.
func healingFixture(t *testing.T, h *apiHarness) *atomic.Int32 {
	calls, _ := healingFixtureWithURL(t, h)
	return calls
}

func healingFixtureWithURL(t *testing.T, h *apiHarness) (*atomic.Int32, string) {
	t.Helper()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	t.Setenv("JANUSLY_AUTO_HEALING_ENABLED", "true")
	if res := h.call("POST", "/org/config", map[string]any{
		"key": "autoHealing.enabled", "value": true,
	}, ""); res.status != 200 {
		t.Fatalf("org opt-in: %d %+v", res.status, res.body)
	}
	var calls atomic.Int32
	flaky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) <= 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(flaky.Close)
	workflow := map[string]any{
		"id": "wf-llmheal-" + fmt.Sprint(time.Now().UnixNano()), "name": "Heal", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": flaky.URL, "timeoutMs": 2000,
		}}},
		"edges": []any{},
	}
	for i := 0; i < 2; i++ {
		calls.Store(0)
		res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
		runID := extractRunID(t, res)
		h.waitRun(runID, "failed")
	}
	return &calls, flaky.URL
}

func proposalRow(t *testing.T, h *apiHarness) (label string, confidence float64, validationRunID string) {
	t.Helper()
	pool := testPool(t)
	err := pool.QueryRow(t.Context(),
		`SELECT coalesce(approach_label,''), coalesce(confidence,0), coalesce(validation_run_id,'')
		 FROM auto_healing_runs WHERE org_id = $1`, h.org).Scan(&label, &confidence, &validationRunID)
	if err != nil {
		t.Fatalf("healing row: %v", err)
	}
	return label, confidence, validationRunID
}

func TestAutoHealingLlmProposal(t *testing.T) {
	h := newAPIHarness(t)
	// Fixture first: the simulated model may harden resilience controls but
	// cannot repeat or change the destination from the workflow snapshot.
	calls, _ := healingFixtureWithURL(t, h)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(
			`{"patchedConfig":{"retry":{"maxAttempts":4,"delayMs":500,"backoff":"exponential"},"timeoutMs":8000},"confidence":72}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)
	calls.Store(100) // validation replay succeeds
	if res := h.call("POST", "/auto-healing/scan", nil, ""); res.body["proposed"] != float64(1) {
		t.Fatalf("scan: %+v", res.body)
	}
	label, confidence, validationRunID := proposalRow(t, h)
	if label != "llm_patch" || confidence != 72 {
		t.Fatalf("LLM proposal must carry its label + model confidence: %s %v", label, confidence)
	}
	if validationRunID == "" {
		t.Fatal("LLM proposal must still go through sandbox validation")
	}
	h.waitRun(validationRunID, "succeeded")
	eng := engine.New(testPool(t))
	if result := eng.SweepAutoHealing(t.Context()); result.Promoted != 1 {
		t.Fatalf("promotion: %+v", result)
	}
}

func TestAutoHealingLlmCannotMutateWorkflowAuthority(t *testing.T) {
	h := newAPIHarness(t)
	calls, _ := healingFixtureWithURL(t, h)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(
			`{"patchedConfig":{"url":"https://attacker.invalid","method":"POST","retry":{"maxAttempts":4}},"confidence":99}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)
	calls.Store(100)
	if res := h.call("POST", "/auto-healing/scan", nil, ""); res.body["proposed"] != float64(1) {
		t.Fatalf("scan: %+v", res.body)
	}
	if label, _, _ := proposalRow(t, h); label != "harden_retries" {
		t.Fatalf("authority-changing model patch must fall back, got %s", label)
	}
	var patch json.RawMessage
	if err := testPool(t).QueryRow(t.Context(),
		`SELECT proposed_patch_json FROM auto_healing_runs WHERE org_id = $1`, h.org).Scan(&patch); err != nil {
		t.Fatalf("stored patch: %v", err)
	}
	if strings.Contains(string(patch), "attacker") || strings.Contains(string(patch), `"method"`) {
		t.Fatalf("authority-changing fields reached persistence: %s", patch)
	}
}

func TestAutoHealingLlmFallsBackWithoutKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarness(t)
	calls := healingFixture(t, h)
	calls.Store(100)
	if res := h.call("POST", "/auto-healing/scan", nil, ""); res.body["proposed"] != float64(1) {
		t.Fatalf("scan: %+v", res.body)
	}
	if label, _, _ := proposalRow(t, h); label != "harden_retries" {
		t.Fatalf("no key must keep the deterministic proposal, got %s", label)
	}
}

func TestAutoHealingLlmRespectsBudget(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	// A blocked budget: tiny limit, block policy, spend already recorded.
	for key, value := range map[string]any{
		"ai.budgetMonthlyUsd": 0.01, "ai.budgetExceededPolicy": "block",
	} {
		if res := h.call("POST", "/org/config", map[string]any{"key": key, "value": value}, ""); res.status != 200 {
			t.Fatalf("budget config: %d %+v", res.status, res.body)
		}
	}
	if _, err := pool.Exec(t.Context(),
		`INSERT INTO usage_events (id, org_id, metric, quantity, metadata)
		 VALUES ($1, $2, 'llm.completion', 100, '{"costUsd": 5}'::jsonb)`,
		"usage-"+fmt.Sprint(time.Now().UnixNano()), h.org); err != nil {
		t.Fatalf("seed spend: %v", err)
	}
	unreachable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("budget-blocked healing must never dial the provider")
	}))
	t.Cleanup(unreachable.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", unreachable.URL)

	calls := healingFixture(t, h)
	calls.Store(100)
	if res := h.call("POST", "/auto-healing/scan", nil, ""); res.body["proposed"] != float64(1) {
		t.Fatalf("scan: %+v", res.body)
	}
	if label, _, _ := proposalRow(t, h); label != "harden_retries" {
		t.Fatalf("blocked budget must keep the deterministic proposal, got %s", label)
	}
	// The block itself is audited (the budget counter's paper trail).
	var blocked int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'billing.budget.exceeded'`, h.org).Scan(&blocked)
	if blocked == 0 {
		t.Fatal("budget block must audit billing.budget.exceeded")
	}
}
