//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"
)

// Run-count semantics are content-bound: exact saved documents stamp a real
// immutable version id (including older clients that omit the optional claim),
// while edited drafts remain ad-hoc and never impersonate a version row.
func TestVersionAttributionSemantics(t *testing.T) {
	h := newAPIHarness(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	workflowID := "attr-" + suffix

	doc := map[string]any{
		"id": workflowID, "name": "Attribution", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	saved := h.call("POST", "/workflows/save", doc, "")
	if saved.status != 200 {
		t.Fatalf("save: %d %+v", saved.status, saved.body)
	}
	versionID, _ := saved.body["versionId"].(string)
	if versionID == "" {
		t.Fatalf("save did not return version identity: %+v", saved.body)
	}

	// An older client can omit workflowVersionId. Exact latest content is still
	// recognized and attributed to the immutable version.
	res := h.call("POST", "/start", map[string]any{"workflow": doc}, "")
	if res.status != 200 {
		t.Fatalf("start doc: %d %+v", res.status, res.body)
	}
	h.waitRun(res.body["runId"].(string), "succeeded")
	var attributedVersion string
	if err := testPool(t).QueryRow(t.Context(), `SELECT workflow_version_id FROM runs WHERE org_id=$1 AND id=$2`,
		h.org, res.body["runId"]).Scan(&attributedVersion); err != nil || attributedVersion != versionID {
		t.Fatalf("exact saved run attribution mismatch: version=%q want=%q err=%v", attributedVersion, versionID, err)
	}

	// A caller may explicitly pin an exact version. A changed document cannot
	// reuse that authority, and the same edited draft without a claim is ad hoc.
	pinned := h.call("POST", "/start", map[string]any{
		"workflow": doc, "workflowVersionId": versionID,
	}, "")
	if pinned.status != 200 {
		t.Fatalf("start exact version: %d %+v", pinned.status, pinned.body)
	}
	h.waitRun(pinned.body["runId"].(string), "succeeded")
	edited := map[string]any{
		"id": workflowID, "name": "Edited draft", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	mismatch := h.call("POST", "/start", map[string]any{
		"workflow": edited, "workflowVersionId": versionID,
	}, "")
	if mismatch.status != 409 || mismatch.body["code"] != "workflow_version_mismatch" {
		t.Fatalf("mismatched explicit version must fail closed: %d %+v", mismatch.status, mismatch.body)
	}
	adhoc := h.call("POST", "/start", map[string]any{"workflow": edited}, "")
	if adhoc.status != 200 {
		t.Fatalf("start edited ad-hoc document: %d %+v", adhoc.status, adhoc.body)
	}
	adhocRunID := adhoc.body["runId"].(string)
	h.waitRun(adhocRunID, "succeeded")
	var adhocVersion string
	if err := testPool(t).QueryRow(t.Context(), `SELECT workflow_version_id FROM runs WHERE org_id=$1 AND id=$2`,
		h.org, adhocRunID).Scan(&adhocVersion); err != nil || adhocVersion != adhocRunID {
		t.Fatalf("ad-hoc run must use run-scoped identity: version=%q run=%q err=%v",
			adhocVersion, adhocRunID, err)
	}

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

	// Both exact starts count; the edited ad-hoc draft does not.
	plain := rowFor(workflowID)
	if plain["runCount"] != float64(2) || plain["lastRunStatus"] != "succeeded" {
		t.Fatalf("only exact saved runs must count: %+v", plain)
	}
	// Version-stamped trigger run: counted.
	triggered := rowFor(workflowID + "-trig")
	if triggered["runCount"] != float64(1) || triggered["lastRunStatus"] != "succeeded" {
		t.Fatalf("version-linked runs must count: %+v", triggered)
	}

	// Health attribution keeps seeing exact and ad-hoc runs through its
	// version-row join plus bounded snapshot fallback.
	health := h.call("GET", "/v1/workflows/health?workflowId="+workflowID, nil, "")
	if health.status != 200 {
		t.Fatalf("workflow health: %d %+v", health.status, health.body)
	}
	score, ok := health.body["data"].(map[string]any)
	if !ok {
		t.Fatalf("workflow health data malformed: %+v", health.body)
	}
	if score["score"] == nil {
		t.Fatalf("health must attribute exact version-bound runs: %+v", score)
	}
}
