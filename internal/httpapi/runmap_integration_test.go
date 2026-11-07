//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestRunMapShowsTimeCostStuckLanesAndNeedsYou(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	editor, other, viewer := "editor-"+suffix, "other-"+suffix, "viewer-"+suffix
	for user, role := range map[string]string{editor: "editor", other: "editor", viewer: "viewer"} {
		if _, err := pool.Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`,
			"m-"+user, h.org, user, role); err != nil {
			t.Fatal(err)
		}
	}
	runID := "run-map-" + suffix
	doc, _ := json.Marshal(map[string]any{"workflow": map[string]any{"id": "wf-map-" + suffix, "nodes": []any{
		map[string]any{"id": "think", "type": "agent"}, map[string]any{"id": "slow", "type": "http"},
		map[string]any{"id": "gate", "type": "tool"}, map[string]any{"id": "sign", "type": "approval"},
	}}})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO runs (id, org_id, workflow_version_id, workflow_id, status, input_json) VALUES ($1, $2, 'v', $3, 'running', $4)`,
		runID, h.org, "wf-map-"+suffix, doc)
	exec(`INSERT INTO run_nodes (id, run_id, org_id, node_id, status, started_at, finished_at) VALUES
		($1, $2, $3, 'think', 'succeeded', now() - interval '2 minutes', now() - interval '1 minute'),
		($4, $2, $3, 'slow', 'running', now() - interval '20 minutes', NULL)`, runID+"-a", runID, h.org, runID+"-b")
	exec(`INSERT INTO run_nodes (id, run_id, org_id, node_id, status, started_at, state_json) VALUES
		($1, $2, $3, 'gate', 'waiting', now(), '{"waiting":{"kind":"tool_approval"}}'),
		($4, $2, $3, 'sign', 'waiting', now(), '{"waiting":{"kind":"approval"}}')`, runID+"-c", runID, h.org, runID+"-d")
	exec(`INSERT INTO tool_approval_requests (id, org_id, run_id, node_id, tool, params_json, params_digest, requester_ids, expires_at)
		VALUES ($1, $2, $3, 'gate', 'http.request', '{}', 'digest', ARRAY[$4], now() + interval '30 minutes')`, "ta-"+suffix, h.org, runID, editor)
	exec(`INSERT INTO usage_events (id, org_id, run_id, metric, quantity, metadata) VALUES
		($1, $2, $3, 'llm.completion', 1200, '{"nodeId":"think","costUsd":0.0125}')`, "u-"+suffix, h.org, runID)
	exec(`INSERT INTO run_events (id, run_id, org_id, node_id, type, payload) VALUES
		($1, $2, $3, 'think', 'agent.tool.started', '{"tool":"http.request"}'),
		($4, $2, $3, 'think', 'agent.completed', '{"status":"ok"}')`, "e1-"+suffix, runID, h.org, "e2-"+suffix)

	as := func(user string) map[string]string { return map[string]string{"x-user-id": user} }
	res := h.callWithHeaders("GET", "/runs/"+runID+"/map", nil, "", as(editor))
	if res.status != 200 {
		t.Fatalf("run map: %d %v", res.status, res.body)
	}
	nodes := map[string]map[string]any{}
	for _, raw := range res.body["nodes"].([]any) {
		node := raw.(map[string]any)
		nodes[node["nodeId"].(string)] = node
	}
	if nodes["slow"]["stuck"] != true || nodes["think"]["stuck"] != false || nodes["think"]["costUsd"] != 0.0125 || nodes["think"]["elapsedMs"] == nil {
		t.Fatalf("time, cost or stuck: %v", nodes)
	}
	if nodes["gate"]["needsYou"] != false || nodes["sign"]["needsYou"] != true {
		t.Fatalf("the requester was asked to approve its own call, or a person step was hidden: %v %v", nodes["gate"], nodes["sign"])
	}
	lanes := res.body["lanes"].([]any)
	if len(lanes) != 1 || len(lanes[0].(map[string]any)["steps"].([]any)) != 2 {
		t.Fatalf("agent lane: %v", lanes)
	}
	if other := h.callWithHeaders("GET", "/runs/"+runID+"/map", nil, "", as(other)); other.body["nodes"] == nil {
		t.Fatalf("another editor: %v", other.body)
	} else {
		for _, raw := range other.body["nodes"].([]any) {
			if node := raw.(map[string]any); node["nodeId"] == "gate" && node["needsYou"] != true {
				t.Fatalf("an eligible approver does not see the tool approval: %v", node)
			}
		}
	}

	inbox := func(user string) map[string]int {
		t.Helper()
		res := h.callWithHeaders("GET", "/needs-you", nil, "", as(user))
		if res.status != 200 {
			t.Fatalf("needs-you: %d %v", res.status, res.body)
		}
		kinds := map[string]int{}
		for _, raw := range res.body["items"].([]any) {
			kinds[raw.(map[string]any)["kind"].(string)]++
		}
		return kinds
	}
	if kinds := inbox(editor); kinds["tool_approval"] != 0 || kinds["approval"] != 1 {
		t.Fatalf("requester inbox: %v", kinds)
	}
	if kinds := inbox(other); kinds["tool_approval"] != 1 || kinds["approval"] != 1 {
		t.Fatalf("approver inbox: %v", kinds)
	}
	if kinds := inbox(viewer); len(kinds) != 0 {
		t.Fatalf("a viewer was asked to decide: %v", kinds)
	}
	if res := h.callWithHeaders("GET", "/runs/"+runID+"/map", nil, "other-org-"+suffix, as(editor)); res.status != 404 && res.status != 403 {
		t.Fatalf("another organization read the run map: %d", res.status)
	}
}
