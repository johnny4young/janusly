//go:build integration

package httpapi

import (
	"fmt"
	"net/url"
	"slices"
	"testing"
	"time"
)

// Health rollup + delta: real runs feed the reliability signals, the
// declared SLO uses the admin chokepoint, and the delta route splits by
// version cutoff with the same-failure signature check.
func TestWorkflowHealthAndDelta(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-health-" + suffix

	workflow := map[string]any{
		"id": wfID, "name": "Salud", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}
	if res := h.call("POST", "/workflows/"+wfID+"/slo", map[string]any{
		"slo": workflowSloDeclaration(90.0),
	}, ""); res.status != 200 {
		t.Fatalf("declare slo: %+v", res.body)
	}
	// Six green runs of version 1.
	for i := 0; i < 6; i++ {
		res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
		h.waitRun(extractRunID(t, res), "succeeded")
	}

	res := h.call("GET", "/workflows/health?workflowId="+wfID, nil, "")
	if res.status != 200 {
		t.Fatalf("health: %d %+v", res.status, res.body)
	}
	healthBlock := res.body
	if _, wrapped := healthBlock["health"]; wrapped {
		t.Fatalf("legacy health must be the raw score: %+v", healthBlock)
	}
	if healthBlock["status"] != "healthy" {
		t.Fatalf("healthy workflow: %+v", healthBlock)
	}
	reliability := healthBlock["breakdown"].(map[string]any)["reliability"].(map[string]any)
	if reliability["score"] != float64(100) {
		t.Fatalf("reliability with 6/6 green: %+v", reliability)
	}
	slo := healthBlock["slo"].(map[string]any)
	if slo["breaches"].(map[string]any)["anyBreach"] != false {
		t.Fatalf("slo must not breach: %+v", slo)
	}

	// Unknown workflow stays enumeration-safe.
	if res = h.call("GET", "/workflows/health?workflowId=ghost-"+suffix, nil, ""); res.status != 404 {
		t.Fatalf("ghost must 404: %d", res.status)
	}

	// Version 2 (the "apply"): delta with afterVersion=2 — before carries
	// the six green runs, after starts empty (gathering data).
	if res = h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("save v2: %+v", res.body)
	}
	res = h.call("GET", "/workflows/health/delta?workflowId="+wfID+"&afterVersion=2", nil, "")
	if res.status != 200 {
		t.Fatalf("delta: %d %+v", res.status, res.body)
	}
	wantDeltaKeys := []string{
		"after", "afterVersion", "before", "delta", "hasEnoughData", "priorVersion",
		"recentRunsAgainstAfter", "sameFailureSinceApply", "windowDays", "workflowId",
	}
	if got := keysOf(res.body); !slices.Equal(got, wantDeltaKeys) {
		t.Fatalf("delta key contract: got %v want %v", got, wantDeltaKeys)
	}
	if res.body["hasEnoughData"] != false {
		t.Fatalf("fresh after-side must gather data: %+v", res.body)
	}
	if res.body["delta"] != nil || res.body["sameFailureSinceApply"] != nil {
		t.Fatalf("fresh delta/signature blocks must be null: %+v", res.body)
	}
	if res.body["workflowId"] != wfID || res.body["afterVersion"] != float64(2) ||
		res.body["windowDays"] != float64(30) {
		t.Fatalf("delta identity/window: %+v", res.body)
	}
	recent := res.body["recentRunsAgainstAfter"].(map[string]any)
	if recent["totalRuns"] != float64(0) || recent["succeeded"] != float64(0) ||
		recent["failed"] != float64(0) || recent["running"] != float64(0) {
		t.Fatalf("fresh run counter: %+v", recent)
	}
	prior := res.body["priorVersion"].(map[string]any)
	if prior["version"] != float64(1) || prior["versionId"] == "" {
		t.Fatalf("prior version affordance: %+v", prior)
	}
	before := res.body["before"].(map[string]any)["signals"].(map[string]any)
	if before["totalRuns"] != float64(6) {
		t.Fatalf("before side must hold the v1 runs: %+v", before)
	}

	// Five green post-cutoff runs flip hasEnoughData; same-failure check
	// answers cleanly when no matching dead letter exists.
	for i := 0; i < 5; i++ {
		res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
		h.waitRun(extractRunID(t, res), "succeeded")
	}
	res = h.call("GET", "/workflows/health/delta?workflowId="+wfID+
		"&afterVersion=2&priorFailureSignature=sig-nunca-vista", nil, "")
	if res.status != 200 || res.body["hasEnoughData"] != true {
		t.Fatalf("after side with 5 runs: %+v", res.body)
	}
	sameFailure := res.body["sameFailureSinceApply"].(map[string]any)
	if sameFailure["count"] != float64(0) || sameFailure["priorSignature"] != "sig-nunca-vista" ||
		len(sameFailure["sampleDeadLetterIds"].([]any)) != 0 {
		t.Fatalf("same-failure clean case: %+v", sameFailure)
	}
	delta := res.body["delta"].(map[string]any)
	if got := keysOf(delta); !slices.Equal(got, []string{"costPerRunUsd", "p95LatencyMs", "score"}) {
		t.Fatalf("delta metric contract: %v", got)
	}
	recent = res.body["recentRunsAgainstAfter"].(map[string]any)
	if recent["totalRuns"] != float64(5) || recent["succeeded"] != float64(5) ||
		recent["failed"] != float64(0) || recent["running"] != float64(0) {
		t.Fatalf("post-Apply run counter: %+v", recent)
	}

	// One production failure and one still-running production run are both
	// visible in the always-on counter, while only the terminal failure
	// contributes to health. A validation run is excluded from both.
	failureRunID := "run-health-failure-" + suffix
	dlqID := "dlq-health-failure-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, $3, 'failed', '{}')`, failureRunID, h.org, wfID); err != nil {
		t.Fatalf("seed failed run: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO dead_letters
		(id, org_id, run_id, node_id, workflow_json, node_json, error_json)
		VALUES ($1, $2, $3, 'request', $4::jsonb, '{"type":"http"}',
		        '{"message":"HTTP 401 unauthorized"}')`, dlqID, h.org, failureRunID,
		fmt.Sprintf(`{"id":%q,"nodes":[],"edges":[]}`, wfID)); err != nil {
		t.Fatalf("seed matching DLQ: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, $3, 'running', '{}'), ($4, $2, $3, 'succeeded', '{}')`,
		"run-health-open-"+suffix, h.org, wfID, "run-health-validation-"+suffix); err != nil {
		t.Fatalf("seed open/validation runs: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET replay_mode = 'validation' WHERE id = $1`,
		"run-health-validation-"+suffix); err != nil {
		t.Fatalf("mark validation run: %v", err)
	}
	res = h.call("GET", "/workflows/health/delta?workflowId="+wfID+
		"&afterVersion=2.0&priorFailureSignature="+url.QueryEscape("HTTP 401 on http node"), nil, "")
	if res.status != 200 {
		t.Fatalf("delta with recurrence: %d %+v", res.status, res.body)
	}
	recent = res.body["recentRunsAgainstAfter"].(map[string]any)
	if recent["totalRuns"] != float64(7) || recent["succeeded"] != float64(5) ||
		recent["failed"] != float64(1) || recent["running"] != float64(1) {
		t.Fatalf("production-only status counter: %+v", recent)
	}
	sameFailure = res.body["sameFailureSinceApply"].(map[string]any)
	samples := sameFailure["sampleDeadLetterIds"].([]any)
	if sameFailure["count"] != float64(1) || sameFailure["priorSignature"] != "HTTP 401 on http node" ||
		len(samples) != 1 || samples[0] != dlqID {
		t.Fatalf("same-failure recurrence: %+v", sameFailure)
	}

	// Integer query values follow Number(...) semantics, and valid values
	// outside the supported window are clamped rather than defaulted.
	if clamped := h.call("GET", "/workflows/health/delta?workflowId="+wfID+
		"&afterVersion=2&windowDays=0", nil, ""); clamped.body["windowDays"] != float64(1) {
		t.Fatalf("low window clamp: %+v", clamped.body)
	}
	if clamped := h.call("GET", "/workflows/health/delta?workflowId="+wfID+
		"&afterVersion=2&windowDays=99", nil, ""); clamped.body["windowDays"] != float64(30) {
		t.Fatalf("high window clamp: %+v", clamped.body)
	}
}

func TestWorkflowHealthFailsClosedOnMalformedPersistedSlo(t *testing.T) {
	h := newAPIHarness(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-health-malformed-slo-" + suffix
	workflow := map[string]any{
		"id": wfID, "name": "Malformed SLO", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}
	if _, err := testPool(t).Exec(t.Context(), `UPDATE workflow_versions
		SET slo_json='{}'::jsonb WHERE org_id=$1 AND workflow_id=$2`, h.org, wfID); err != nil {
		t.Fatalf("corrupt persisted SLO: %v", err)
	}
	for _, path := range []string{
		"/workflows/health?workflowId=" + wfID,
		"/workflows/health/delta?workflowId=" + wfID + "&afterVersion=1",
	} {
		res := h.call("GET", path, nil, "")
		if res.status != 500 || res.body["code"] != "internal_error" {
			t.Fatalf("malformed SLO must fail closed at %s: %d %+v", path, res.status, res.body)
		}
	}
}

func TestWorkflowHealthTreatsAbsentPersistedSloAsUndeclared(t *testing.T) {
	h := newAPIHarness(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-health-no-slo-" + suffix
	workflow := map[string]any{
		"id": wfID, "name": "No declared SLO", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}

	for _, tc := range []struct {
		name string
		path string
		v1   bool
	}{
		{name: "legacy", path: "/workflows/health?workflowId=" + wfID},
		{name: "v1", path: "/v1/workflows/health?workflowId=" + wfID, v1: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := h.call("GET", tc.path, nil, "")
			if res.status != 200 {
				t.Fatalf("health: %d %+v", res.status, res.body)
			}
			score := res.body
			if tc.v1 {
				var ok bool
				score, ok = res.body["data"].(map[string]any)
				if !ok {
					t.Fatalf("v1 health data malformed: %+v", res.body)
				}
			}
			if score["score"] == nil || score["slo"] != nil {
				t.Fatalf("absent SLO must be a successful undeclared score: %+v", score)
			}
		})
	}

	// Delta remains an explicitly registered unversioned read surface; it
	// shares the same health-context loader and must preserve the same null-SLO
	// semantics on both score sides.
	res := h.call("GET", "/workflows/health/delta?workflowId="+wfID+"&afterVersion=1", nil, "")
	if res.status != 200 {
		t.Fatalf("health delta: %d %+v", res.status, res.body)
	}
	for _, side := range []string{"before", "after"} {
		score, ok := res.body[side].(map[string]any)
		if !ok || score["score"] == nil || score["slo"] != nil {
			t.Fatalf("absent SLO must remain undeclared on %s: %+v", side, res.body)
		}
	}
}
