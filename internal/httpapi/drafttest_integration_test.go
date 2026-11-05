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
	"time"
)

func draftWorkflow(id, url string) map[string]any {
	retry := map[string]any{"maxAttempts": 1}
	return map[string]any{
		"id": id, "name": "Draft", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "fetch", "type": "http", "config": map[string]any{"url": url + "/read", "method": "GET", "retry": retry}},
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{"mapping": map[string]any{"got": "{{context.fetch.output.body.ok}}"}}},
			map[string]any{"id": "charge", "type": "http", "config": map[string]any{"url": url + "/charge", "method": "POST", "retry": retry}},
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{}},
		},
		"edges": []any{
			map[string]any{"from": "fetch", "to": "shape"},
			map[string]any{"from": "shape", "to": "charge"},
			map[string]any{"from": "charge", "to": "gate"},
		},
	}
}

func (h *apiHarness) savedDraftSource(url string) (string, string) {
	h.t.Helper()
	id := fmt.Sprintf("wf-draft-%d", time.Now().UnixNano())
	if res := h.call("POST", "/workflows/save", draftWorkflow(id, url), ""); res.status != 200 {
		h.t.Fatalf("save: %d %+v", res.status, res.body)
	}
	runID := extractRunID(h.t, h.call("POST", "/v1/start", map[string]any{"workflow": draftWorkflow(id, url)}, ""))
	deadline := time.Now().Add(10 * time.Second)
	for h.nodeStatus(runID, "gate") != "waiting" {
		if time.Now().After(deadline) {
			h.t.Fatal("the source run never reached its approval")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return id, runID
}

func (h *apiHarness) nodeStatus(runID, nodeID string) string {
	var status string
	_ = testPool(h.t).QueryRow(context.Background(), `SELECT status FROM run_nodes WHERE run_id=$1 AND node_id=$2`, runID, nodeID).Scan(&status)
	return status
}

func (h *apiHarness) nodeState(runID, nodeID string) string {
	var state string
	_ = testPool(h.t).QueryRow(context.Background(), `SELECT state_json::text FROM run_nodes WHERE run_id=$1 AND node_id=$2`, runID, nodeID).Scan(&state)
	return state
}

func TestDraftTestUsesStandInsWithoutEffectsOrVersions(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	target := newRerunTarget(t)
	workflowID, sourceRunID := h.savedDraftSource(target.URL)
	if target.reads.Load() != 1 || target.writes.Load() != 1 {
		t.Fatalf("source run: reads=%d writes=%d", target.reads.Load(), target.writes.Load())
	}
	// A legacy row saved before persistence masking: the pin must mask it again.
	if _, err := pool.Exec(ctx, `UPDATE run_nodes SET state_json = '{"output":{"body":{"ok":"yes"},"token":"raw-secret"}}' WHERE run_id=$1 AND node_id='fetch'`, sourceRunID); err != nil {
		t.Fatalf("seed source output: %v", err)
	}
	var versions, productionRuns int
	count := func() (int, int) {
		var v, p int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_versions WHERE org_id=$1 AND workflow_id=$2`, h.org, workflowID).Scan(&v)
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE org_id=$1 AND workflow_id=$2 AND replay_mode IS NULL`, h.org, workflowID).Scan(&p)
		return v, p
	}
	versions, productionRuns = count()

	started := h.call("POST", "/runs/draft-test", map[string]any{
		"workflow": draftWorkflow(workflowID, target.URL),
		"pins": map[string]any{
			"fetch": map[string]any{"sourceRunId": sourceRunID},
			"gate":  nil,
		},
	}, "")
	if started.status != 422 || started.body["code"] != "draft_pin_not_allowed" {
		t.Fatalf("an approval cannot be pinned: %d %+v", started.status, started.body)
	}
	started = h.call("POST", "/runs/draft-test", map[string]any{
		"workflow": draftWorkflow(workflowID, target.URL),
		"input":    map[string]any{"triggeredBy": "schedule"},
		"pins":     map[string]any{"fetch": map[string]any{"sourceRunId": sourceRunID}},
	}, "")
	if started.status != 200 {
		t.Fatalf("draft test: %d %+v", started.status, started.body)
	}
	runID := started.body["runId"].(string)
	deadline := time.Now().Add(10 * time.Second)
	for h.nodeStatus(runID, "gate") != "waiting" {
		if time.Now().After(deadline) {
			t.Fatalf("the approval must still wait in a test run: %s", h.nodeStatus(runID, "gate"))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if target.reads.Load() != 1 || target.writes.Load() != 1 {
		t.Fatalf("a pinned step and the write after it must not reach the target: reads=%d writes=%d", target.reads.Load(), target.writes.Load())
	}
	relaundered := h.call("POST", "/runs/draft-test", map[string]any{
		"workflow": draftWorkflow(workflowID, target.URL),
		"pins":     map[string]any{"fetch": map[string]any{"sourceRunId": runID}},
	}, "")
	if relaundered.status != 422 || relaundered.body["code"] != "draft_pin_no_output" {
		t.Fatalf("a stand-in is not a real output to pin again: %d %+v", relaundered.status, relaundered.body)
	}
	fetch := h.nodeState(runID, "fetch")
	if strings.Contains(fetch, "raw-secret") || !strings.Contains(fetch, "[redacted]") {
		t.Fatalf("the pinned output must stay masked: %s", fetch)
	}
	if shape := h.nodeState(runID, "shape"); !strings.Contains(shape, `"got": "yes"`) && !strings.Contains(shape, `"got":"yes"`) {
		t.Fatalf("the next step must read the pinned output: %s", shape)
	}
	if charge := h.nodeState(runID, "charge"); !strings.Contains(charge, "validation_dry_run") {
		t.Fatalf("a write after a pin keeps validation suppression: %s", charge)
	}

	var replayMode, evidence, versionID, input string
	var triggerKind *string
	if err := pool.QueryRow(ctx, `SELECT replay_mode, validation_evidence_level, workflow_version_id, input_json::text, trigger_kind FROM runs WHERE id=$1`, runID).
		Scan(&replayMode, &evidence, &versionID, &input, &triggerKind); err != nil {
		t.Fatalf("run row: %v", err)
	}
	if replayMode != "validation" || evidence != "writes_skipped" || versionID != runID || !strings.Contains(input, `"draftTest"`) {
		t.Fatalf("a draft test is an unversioned validation run that proves nothing: %s %s %s", replayMode, evidence, versionID)
	}
	if strings.Contains(input, "raw-secret") {
		t.Fatal("the run's stored stand-in must be masked too")
	}
	if triggerKind != nil {
		t.Fatalf("a draft test must not read as a schedule fire: %s", *triggerKind)
	}
	if v, p := count(); v != versions || p != productionRuns {
		t.Fatalf("a draft test must not create a version or a production run: versions %d→%d production %d→%d", versions, v, productionRuns, p)
	}
	var leaked int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_versions WHERE org_id=$1 AND dag_json::text LIKE '%draftTest%'`, h.org).Scan(&leaked)
	if leaked != 0 {
		t.Fatal("pins must never reach a saved version")
	}
	var metadata string
	if err := pool.QueryRow(ctx, `SELECT metadata::text FROM audit_logs WHERE org_id=$1 AND action='run.draft_test_started' AND target_id=$2`, h.org, runID).Scan(&metadata); err != nil {
		t.Fatalf("audit: %v", err)
	}
	if strings.Contains(metadata, "yes") || !strings.Contains(metadata, "fetch") {
		t.Fatalf("audit names the stand-ins, never their values: %s", metadata)
	}

	// The same envelope smuggled into a production start is ignored: the step runs.
	production := h.call("POST", "/v1/start", map[string]any{
		"workflow": draftWorkflow(workflowID, target.URL),
		"input":    map[string]any{"draftTest": map[string]any{"pins": map[string]any{"fetch": map[string]any{"kind": "mocked", "output": 1}}}},
	}, "")
	productionID := extractRunID(t, production)
	for h.nodeStatus(productionID, "gate") != "waiting" {
		if time.Now().After(deadline.Add(10 * time.Second)) {
			t.Fatal("production run stalled")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if target.reads.Load() != 2 || target.writes.Load() != 2 {
		t.Fatalf("a production run must execute every step: reads=%d writes=%d", target.reads.Load(), target.writes.Load())
	}
}

func TestDraftTestRunsOneStepWithAMock(t *testing.T) {
	h := newAPIHarness(t)
	target := newRerunTarget(t)
	workflowID, _ := h.savedDraftSource(target.URL)
	started := h.call("POST", "/runs/draft-test", map[string]any{
		"workflow":   draftWorkflow(workflowID, target.URL),
		"pins":       map[string]any{"fetch": map[string]any{"mock": map[string]any{"body": map[string]any{"ok": "mocked"}, "apiKey": "typed-secret"}}},
		"stepNodeId": "shape",
	}, "")
	if started.status != 200 {
		t.Fatalf("step test: %d %+v", started.status, started.body)
	}
	runID := started.body["runId"].(string)
	h.waitRun(runID, "succeeded")
	if target.reads.Load() != 1 || target.writes.Load() != 1 {
		t.Fatalf("only the step may run: reads=%d writes=%d", target.reads.Load(), target.writes.Load())
	}
	var input string
	_ = testPool(t).QueryRow(context.Background(), `SELECT input_json::text FROM runs WHERE id=$1`, runID).Scan(&input)
	if fetch := h.nodeState(runID, "fetch"); strings.Contains(fetch, "typed-secret") || strings.Contains(input, "typed-secret") || input == "" {
		t.Fatalf("a mocked credential must be masked: %s", fetch)
	}
	if shape := h.nodeState(runID, "shape"); !strings.Contains(shape, "mocked") {
		t.Fatalf("the step must read the mock: %s", shape)
	}
	for _, nodeID := range []string{"charge", "gate"} {
		if status := h.nodeStatus(runID, nodeID); status != "skipped" {
			t.Fatalf("%s is outside the step and must not run: %s", nodeID, status)
		}
	}
}

func TestDraftTestIsScopedToTheOrganizationAndWorkflow(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	target := newRerunTarget(t)
	workflowID, sourceRunID := h.savedDraftSource(target.URL)
	otherID, otherRunID := h.savedDraftSource(target.URL)
	request := func(source string) map[string]any {
		return map[string]any{
			"workflow": draftWorkflow(workflowID, target.URL),
			"pins":     map[string]any{"fetch": map[string]any{"sourceRunId": source}},
		}
	}
	if res := h.call("POST", "/runs/draft-test", request(otherRunID), ""); res.status != 422 || res.body["code"] != "draft_pin_other_workflow" {
		t.Fatalf("a pin from another workflow: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/runs/draft-test", request(sourceRunID), "other-org-"+otherID); res.status != 404 {
		t.Fatalf("another organization must not see the workflow: %d %+v", res.status, res.body)
	}
	unsaved := request(sourceRunID)
	unsaved["workflow"] = draftWorkflow("wf-draft-unsaved", target.URL)
	if res := h.call("POST", "/runs/draft-test", unsaved, ""); res.status != 404 || res.body["code"] != "draft_test_unsaved" {
		t.Fatalf("an unsaved workflow: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/runs/draft-test", map[string]any{
		"workflow": draftWorkflow(workflowID, target.URL), "pins": map[string]any{"fetch": map[string]any{}},
	}, ""); res.status != 422 || res.body["code"] != "draft_mock_invalid" {
		t.Fatalf("a pin needs a source or a mock: %d %+v", res.status, res.body)
	}
	if _, err := pool.Exec(ctx, `UPDATE workflows SET status='paused_circuit_breaker' WHERE id=$1 AND org_id=$2`, workflowID, h.org); err != nil {
		t.Fatalf("pause: %v", err)
	}
	if res := h.call("POST", "/runs/draft-test", request(sourceRunID), ""); res.status != 409 || res.body["code"] != "workflow_circuit_breaker_paused" {
		t.Fatalf("a paused workflow refuses tests: %d %+v", res.status, res.body)
	}
}

func TestDraftTestFailuresDoNotCountTowardTheBreaker(t *testing.T) {
	h := newAPIHarness(t)
	b := newRerunBreaker(t, h)
	doc := b.doc()
	doc["nodes"] = append([]any{map[string]any{"id": "seed", "type": "noop", "config": map[string]any{}}}, doc["nodes"].([]any)...)
	doc["edges"] = []any{map[string]any{"from": "seed", "to": "call"}}
	for range 3 {
		res := h.call("POST", "/runs/draft-test", map[string]any{
			"workflow": doc, "pins": map[string]any{"seed": map[string]any{"mock": map[string]any{"n": 1}}},
		}, "")
		if res.status != 200 {
			t.Fatalf("draft test: %d %+v", res.status, res.body)
		}
		h.waitRun(res.body["runId"].(string), "failed")
	}
	if got := b.status(); got != "active" {
		t.Fatalf("failing draft tests must not pause production: %s", got)
	}
	var open int
	_ = testPool(t).QueryRow(context.Background(), `SELECT count(*) FROM dead_letters dl JOIN runs r ON r.id = dl.run_id
		WHERE dl.org_id=$1 AND r.workflow_id=$2 AND dl.replay_mode IS NULL`, h.org, b.id).Scan(&open)
	if open != 0 {
		t.Fatalf("a draft test failure must not open production recovery work: %d", open)
	}
	b.productionFailure()
	b.productionFailure()
	if got := b.status(); got != "active" {
		t.Fatalf("two production failures are below the threshold of 3: %s", got)
	}
	b.productionFailure()
	if got := b.status(); got != "paused_circuit_breaker" {
		t.Fatalf("production failures must still trip the breaker: %s", got)
	}
}

// A draft test enters through runstart, so it keeps every start gate.
func TestDraftTestKeepsTheStartGates(t *testing.T) {
	t.Run("saved-only tenants refuse an edited draft", func(t *testing.T) {
		h := newAPIHarness(t)
		target := newRerunTarget(t)
		workflowID, _ := h.savedDraftSource(target.URL)
		if _, err := testPool(t).Exec(context.Background(), `INSERT INTO org_configs (id,org_id,key,value_json,category,description,value_type)
			VALUES ($1,$2,'runs.requireSavedWorkflow','true','runs','test','boolean')`, h.org+"-saved-only", h.org); err != nil {
			t.Fatalf("config: %v", err)
		}
		edited := draftWorkflow(workflowID, target.URL)
		edited["name"] = "Edited"
		if res := h.call("POST", "/runs/draft-test", map[string]any{"workflow": edited}, ""); res.status != 403 || res.body["code"] != "runs_adhoc_disabled" {
			t.Fatalf("an unsaved draft on a saved-only tenant: %d %+v", res.status, res.body)
		}
		if res := h.call("POST", "/runs/draft-test", map[string]any{"workflow": draftWorkflow(workflowID, target.URL)}, ""); res.status != 200 {
			t.Fatalf("the saved document still tests: %d %+v", res.status, res.body)
		}
	})

	t.Run("production refuses a workflow that is not ready", func(t *testing.T) {
		h := newAPIHarness(t)
		doc := failingHTTPWorkflow("wf-draft-gate-" + h.org)
		doc["name"] = "Gate"
		doc["dslVersion"] = "1.0"
		if res := h.call("POST", "/workflows/save", doc, ""); res.status != 200 {
			t.Fatalf("save: %d %+v", res.status, res.body)
		}
		t.Setenv("JANUSLY_ENV", "production")
		t.Setenv("ALLOW_DEV_AUTH_HEADERS", "true")
		res := h.call("POST", "/runs/draft-test", map[string]any{"workflow": doc}, "")
		if res.status != 422 || res.body["code"] != "runs_not_production_ready" {
			t.Fatalf("readiness: %d %+v", res.status, res.body)
		}
	})

	t.Run("the start rate limit applies", func(t *testing.T) {
		options := defaultV1ServerOptionsForTest()
		options.StartRateLimitPerMinute = 2
		h := newAPIHarnessWithOptions(t, false, options)
		for range 2 {
			if res := h.call("POST", "/runs/draft-test", map[string]any{}, ""); res.status == http.StatusTooManyRequests {
				t.Fatal("tripped early")
			}
		}
		if res := h.call("POST", "/runs/draft-test", map[string]any{}, ""); res.status != http.StatusTooManyRequests {
			t.Fatalf("want 429, got %d %+v", res.status, res.body)
		}
	})

	t.Run("AI steps never reach the provider", func(t *testing.T) {
		var calls atomic.Int64
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
		}))
		t.Cleanup(provider.Close)
		t.Setenv("ANTHROPIC_API_KEY", "test-key")
		t.Setenv("JANUSLY_LOCAL_STACK", "true")
		t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
		t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
		t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", provider.URL)
		h := newAPIHarness(t)
		doc := map[string]any{
			"id": "wf-draft-ai-" + h.org, "name": "AI", "dslVersion": "1.0",
			"nodes": []any{
				map[string]any{"id": "plan", "type": "ai", "config": map[string]any{"prompt": "plan"}},
				map[string]any{"id": "answer", "type": "ai", "config": map[string]any{"prompt": "answer {{context.plan.output.response}}"}},
			},
			"edges": []any{map[string]any{"from": "plan", "to": "answer"}},
		}
		if res := h.call("POST", "/workflows/save", doc, ""); res.status != 200 {
			t.Fatalf("save: %d %+v", res.status, res.body)
		}
		res := h.call("POST", "/runs/draft-test", map[string]any{
			"workflow": doc, "pins": map[string]any{"plan": map[string]any{"mock": map[string]any{"response": "mocked"}}},
		}, "")
		if res.status != 200 {
			t.Fatalf("draft test: %d %+v", res.status, res.body)
		}
		runID := res.body["runId"].(string)
		h.waitRun(runID, "succeeded")
		if calls.Load() != 0 || !strings.Contains(h.nodeState(runID, "answer"), `"dryRun": true`) {
			t.Fatalf("no AI call may be made or billed: calls=%d %s", calls.Load(), h.nodeState(runID, "answer"))
		}
		var usage int
		_ = testPool(t).QueryRow(context.Background(), `SELECT count(*) FROM usage_events WHERE run_id=$1`, runID).Scan(&usage)
		if usage != 0 {
			t.Fatalf("a draft test must not spend budget: %d usage rows", usage)
		}
	})
}
