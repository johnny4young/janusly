//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"
)

// Health rollup + delta: real runs feed the reliability signals, the
// declared SLO rides the save body, and the delta route splits by
// version cutoff with the same-failure signature check.
func TestWorkflowHealthAndDelta(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-health-" + suffix

	workflow := map[string]any{
		"id": wfID, "name": "Salud", "dslVersion": "1.0",
		"slo":   map[string]any{"successRatePercent": 90.0},
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
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
	healthBlock := res.body["health"].(map[string]any)
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
	if res.body["hasEnoughData"] != false {
		t.Fatalf("fresh after-side must gather data: %+v", res.body)
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
	sameFailure := res.body["sameFailure"].(map[string]any)
	if sameFailure["checked"] != true || sameFailure["recurred"] != false {
		t.Fatalf("same-failure clean case: %+v", sameFailure)
	}
	_ = pool
	_ = ctx
}
