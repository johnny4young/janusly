//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"
)

// Run-count semantics match the contract — the Flows list counts
// ONLY version-linked runs (engine-driven paths stamp real version-row
// ids; a doc-posted ad-hoc run never counts, exactly like Node), while
// the health attribution still sees BOTH kinds via its coalesce.
func TestVersionAttributionSemantics(t *testing.T) {
	h := newAPIHarness(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	workflowID := "attr-" + suffix

	doc := map[string]any{
		"id": workflowID, "name": "Attribution", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/workflows/save", doc, ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}

	// A doc-posted run: the contract's doc-id convention — never counted
	// by the list summary.
	res := h.call("POST", "/start", map[string]any{"workflow": doc}, "")
	if res.status != 200 {
		t.Fatalf("start doc: %d %+v", res.status, res.body)
	}
	h.waitRun(res.body["runId"].(string), "succeeded")

	// An engine-driven run: the webhook trigger path stamps the REAL
	// version-row id (effectiveVersionID) — counted.
	trigger := map[string]any{
		"id": workflowID + "-trig", "name": "Attribution trigger", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "hook", "type": "webhook_received", "config": map[string]any{
				"endpointKey": "attr-hook",
			}},
			map[string]any{"id": "done", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "hook", "to": "done"}},
	}
	if res := h.call("POST", "/workflows/save", trigger, ""); res.status != 200 {
		t.Fatalf("save trigger: %d %+v", res.status, res.body)
	}
	res = h.call("POST", "/v1/webhooks/"+workflowID+"-trig", map[string]any{
		"endpointKey": "attr-hook", "eventId": "evt-attr-" + suffix,
		"payload": map[string]any{"event": "ping"},
	}, "")
	if res.status != 200 && res.status != 202 {
		t.Fatalf("trigger ingest: %d %+v", res.status, res.body)
	}
	triggerRun := ""
	if data, ok := res.body["data"].(map[string]any); ok {
		triggerRun, _ = data["runId"].(string)
	}
	if triggerRun == "" {
		triggerRun, _ = res.body["runId"].(string)
	}
	if triggerRun == "" {
		t.Fatalf("trigger run id missing: %+v", res.body)
	}
	h.waitRun(triggerRun, "succeeded")

	rowFor := func(id string) map[string]any {
		list := h.call("GET", "/workflows?limit=50", nil, "")
		// Legacy /workflows returns a bare array.
		req := h.call("GET", "/v1/workflows?limit=50", nil, "")
		rows, _ := req.body["data"].([]any)
		_ = list
		for _, raw := range rows {
			row := raw.(map[string]any)
			if row["id"] == id {
				return row
			}
		}
		t.Fatalf("workflow %s not listed", id)
		return nil
	}

	// Doc-posted run: not counted (node semantics).
	plain := rowFor(workflowID)
	if plain["runCount"] != float64(0) || plain["lastRunStatus"] != nil {
		t.Fatalf("doc-posted runs must not count: %+v", plain)
	}
	// Version-stamped trigger run: counted.
	triggered := rowFor(workflowID + "-trig")
	if triggered["runCount"] != float64(1) || triggered["lastRunStatus"] != "succeeded" {
		t.Fatalf("version-linked runs must count: %+v", triggered)
	}

	// Health attribution keeps seeing BOTH kinds (coalesce: version row
	// join for the stamped run, count-derivation for the doc-id run).
	health := h.call("GET", "/v1/workflows/health?workflowId="+workflowID, nil, "")
	score := health.body["data"].(map[string]any)
	if score["score"] == nil {
		t.Fatalf("health must attribute doc-id runs: %+v", score)
	}
}
