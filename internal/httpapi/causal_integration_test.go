//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// GET /causal — org-scoped 403, event pinned to run+node+type,
// and the replayed ranking with the contract shape.

func TestCausalDecisionExplorer(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	runID, eventID := "run-causal-"+suffix, "ev-causal-"+suffix

	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, 'wfv', 'succeeded', '{}')`, runID, h.org); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	payload := `{"chosenNodeId":"slow-but-good","ranking":[
		{"nodeId":"cheap-fast","breakdown":{"cost":0.1,"latency":0.2,"quality":0.5}},
		{"nodeId":"slow-but-good","breakdown":{"cost":0.4,"latency":0.9,"quality":0.99}}]}`
	if _, err := pool.Exec(ctx, `INSERT INTO run_events (id, run_id, node_id, type, payload)
		VALUES ($1, $2, 'router', 'decision.made', $3::jsonb)`, eventID, runID, payload); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	if res := h.call("GET", "/causal?runId="+runID, nil, ""); res.status != 400 {
		t.Fatalf("missing params must 400: %d", res.status)
	}
	if res := h.call("GET", "/causal?runId=ghost&eventId=x&nodeId=router", nil, ""); res.status != 403 {
		t.Fatalf("foreign run must 403: %d %+v", res.status, res.body)
	}
	if res := h.call("GET", fmt.Sprintf("/causal?runId=%s&eventId=%s&nodeId=WRONG", runID, eventID), nil, ""); res.status != 404 {
		t.Fatalf("node mismatch must 404: %d", res.status)
	}

	replayed := h.call("GET", fmt.Sprintf("/causal?runId=%s&eventId=%s&nodeId=router", runID, eventID), nil, "")
	if replayed.status != 200 {
		t.Fatalf("causal: %d %+v", replayed.status, replayed.body)
	}
	chosen := replayed.body["chosen"].(map[string]any)
	best := replayed.body["best"].(map[string]any)
	if chosen["nodeId"] != "slow-but-good" || best["nodeId"] != "cheap-fast" {
		t.Fatalf("replay ranking: chosen=%+v best=%+v", chosen, best)
	}
	if len(replayed.body["ranking"].([]any)) != 2 || len(replayed.body["alternatives"].([]any)) != 1 {
		t.Fatalf("shape: %+v", replayed.body)
	}
	if replayed.body["explanation"] == "" {
		t.Fatal("explanation must be present")
	}
}
