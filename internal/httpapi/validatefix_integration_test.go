//go:build integration

package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// The Recovery dialog's sandbox gate: a proposed fix seeds a fresh
// validation run (write sides skipped, replay lineage, static evidence)
// against the failing entry's exact input; malformed suggestions and
// stale claims are refused before any run exists.
func TestValidateFixSandboxGate(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")

	// A failing upstream seeds the DLQ entry; it also counts write hits so
	// the validation replay's skip is observable.
	var writes atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes.Add(1)
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()

	failing := map[string]any{
		"id": "wf-fix-src", "name": "Failing", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": upstream.URL, "method": "POST", "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	res := h.call("POST", "/v1/start", map[string]any{
		"workflow": failing, "input": map[string]any{"pedido": "abc-123"},
	}, "")
	runID := extractRunID(t, res)
	h.waitRun(runID, "failed")
	var deadLetterID string
	if err := pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID); err != nil {
		t.Fatalf("dead letter: %v", err)
	}
	baselineWrites := writes.Load()

	// 1. Refusals BEFORE any run is seeded.
	if res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"suggestedWorkflow": failing,
	}, ""); res.status != 400 || res.body["code"] != "dlq_field_required" {
		t.Fatalf("missing id: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": failing,
		"validationEffectMode": "provider_simulation",
	}, ""); res.status != 409 || res.body["code"] != "recovery_provider_simulation_unavailable" {
		t.Fatalf("provider simulation: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": failing,
		"validationEffectMode": "otra_cosa",
	}, ""); res.status != 400 || res.body["code"] != "recovery_validation_effect_mode_invalid" {
		t.Fatalf("bad effect mode: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": failing,
		"recoveryPlaybookId": "pb-1",
	}, ""); res.status != 409 || res.body["code"] != "recovery_playbook_match_changed" {
		t.Fatalf("playbook claim: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID,
		"suggestedWorkflow": map[string]any{"id": "wf-x", "name": "X", "dslVersion": "1.0",
			"nodes": []any{}, "edges": []any{}},
	}, ""); res.status != 400 || res.body["code"] != "dlq_workflow_schema_invalid" {
		t.Fatalf("invalid suggestion: %d %+v", res.status, res.body)
	}
	missingNode := map[string]any{
		"id": "wf-fix-src", "name": "Renamed", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "otro", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": missingNode,
	}, ""); res.status != 400 || res.body["code"] != "dlq_failing_node_missing" {
		t.Fatalf("missing failing node: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": "dl-fantasma", "suggestedWorkflow": failing,
	}, ""); res.status != 404 {
		t.Fatalf("unknown dlq: %d %+v", res.status, res.body)
	}

	// 2. A sound fix seeds the validation run: write side SKIPPED (no hit
	// on the upstream), replay lineage recorded, static evidence, original
	// input carried over.
	fixed := map[string]any{
		"id": "wf-fix-src", "name": "Fixed", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": upstream.URL, "method": "POST", "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": fixed,
	}, "")
	if res.status != 200 {
		t.Fatalf("validate-fix: %d %+v", res.status, res.body)
	}
	validationRunID, _ := res.body["runId"].(string)
	if validationRunID == "" {
		t.Fatalf("runId expected: %+v", res.body)
	}
	h.waitRun(validationRunID, "succeeded")
	if delta := writes.Load() - baselineWrites; delta != 0 {
		t.Fatalf("validation must not hit the write upstream: +%d", delta)
	}
	var replayMode, linkKind, parentRun, evidence string
	var inputJSON []byte
	if err := pool.QueryRow(ctx, `SELECT COALESCE(replay_mode,''), COALESCE(parent_link_kind,''),
		COALESCE(parent_run_id,''), COALESCE(validation_evidence_level,''), input_json
		FROM runs WHERE id = $1`, validationRunID).
		Scan(&replayMode, &linkKind, &parentRun, &evidence, &inputJSON); err != nil {
		t.Fatalf("read validation run: %v", err)
	}
	if replayMode != "validation" || linkKind != "replay" || parentRun != runID || evidence != "static" {
		t.Fatalf("validation lineage: mode=%s kind=%s parent=%s evidence=%s", replayMode, linkKind, parentRun, evidence)
	}
	if !strings.Contains(string(inputJSON), "abc-123") {
		t.Fatalf("original input must seed the sandbox: %s", inputJSON)
	}

	// 3. Audit landed.
	var audits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action = 'recovery.validation_started'`, h.org).Scan(&audits)
	if audits != 1 {
		t.Fatalf("validation_started audit: %d", audits)
	}
}

// The continuation shape: only the failing node re-executes — ancestors
// copy their terminal context from the original run (templates see the
// same upstream outputs), descendants continue via the ordinary cascade,
// and the exact-identity {runId, nodeId} replay re-arms the attempt to 1.
func TestValidateFixContinuationShape(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")

	var healed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healed.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	workflow := map[string]any{
		"id": "wf-cont", "name": "Continuation", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "seed", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"semilla": "valor-ancestro"},
			}},
			map[string]any{"id": "calc", "type": "http", "config": map[string]any{
				"url": upstream.URL, "timeoutMs": 500,
			}},
			map[string]any{"id": "notify", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"eco": "{{context.seed.output.semilla}}"},
			}},
		},
		"edges": []any{
			map[string]any{"from": "seed", "to": "calc"},
			map[string]any{"from": "calc", "to": "notify"},
		},
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	runID := extractRunID(t, res)
	h.waitRun(runID, "failed")
	var deadLetterID string
	if err := pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID); err != nil {
		t.Fatalf("dead letter: %v", err)
	}

	// The continuation validation: heal the upstream, propose the same DAG.
	healed.Store(true)
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": workflow,
	}, "")
	if res.status != 200 {
		t.Fatalf("validate-fix: %d %+v", res.status, res.body)
	}
	validationRunID := res.body["runId"].(string)
	h.waitRun(validationRunID, "succeeded")

	// The seed ancestor never re-executed: its context was COPIED (the
	// original run produced it), and the downstream notify read it.
	var seedState, notifyState []byte
	var seedAttempts int
	_ = pool.QueryRow(ctx, `SELECT state_json, attempts FROM run_nodes WHERE run_id = $1 AND node_id = 'seed'`, validationRunID).Scan(&seedState, &seedAttempts)
	_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'notify'`, validationRunID).Scan(&notifyState)
	if !strings.Contains(string(seedState), "valor-ancestro") {
		t.Fatalf("ancestor context must copy: %s", seedState)
	}
	if !strings.Contains(string(notifyState), "valor-ancestro") {
		t.Fatalf("descendant must read the copied context: %s", notifyState)
	}
	var startedEvents int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1 AND type = 'run.started.validation'`, validationRunID).Scan(&startedEvents)
	if startedEvents != 1 {
		t.Fatalf("run.started.validation expected: %d", startedEvents)
	}

	// Exact-identity replay: {runId, nodeId} revives the ORIGINAL run in
	// place with the attempt re-armed to 1 (Node consistency, F05 closed).
	res = h.call("POST", "/dlq/replay", map[string]any{"runId": runID, "nodeId": "calc"}, "")
	if res.status != 200 {
		t.Fatalf("exact-identity replay: %d %+v", res.status, res.body)
	}
	h.waitRun(runID, "succeeded")
	var attempts int
	_ = pool.QueryRow(ctx, `SELECT attempts FROM run_nodes WHERE run_id = $1 AND node_id = 'calc'`, runID).Scan(&attempts)
	if attempts != 1 {
		t.Fatalf("replay must re-arm the attempt to 1: %d", attempts)
	}
}
