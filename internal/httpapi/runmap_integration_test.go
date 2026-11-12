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
		($4, $2, $3, 'sign', 'waiting', now(), '{"waiting":{"kind":"approval"}}'),
		($5, $2, $3, 'child', 'succeeded', now(), '{"subworkflow":{"childRunId":"child-ok"}}')`, runID+"-c", runID, h.org, runID+"-d", runID+"-e")
	exec(`INSERT INTO run_nodes (id, run_id, org_id, node_id, status, started_at, state_json) VALUES
		($1, $2, $3, 'form', 'waiting', now(), jsonb_build_object('waiting', jsonb_build_object('kind', 'human_form',
		  'resumeTokenExpiresAt', to_char((now() - interval '1 minute') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))`,
		runID+"-g", runID, h.org)
	exec(`INSERT INTO run_nodes (id, run_id, org_id, node_id, status, error_json) VALUES ($1, $2, $3, 'broken', 'failed', '{"childRunId":"child-failed"}')`,
		runID+"-f", runID, h.org)
	exec(`INSERT INTO tool_approval_requests (id, org_id, run_id, node_id, tool, params_json, params_digest, requester_ids, expires_at)
		VALUES ($1, $2, $3, 'gate', 'http.request', '{}', 'digest', ARRAY[$4], now() + interval '30 minutes')`, "ta-"+suffix, h.org, runID, editor)
	exec(`INSERT INTO usage_events (id, org_id, run_id, metric, quantity, metadata) VALUES
		($1, $2, $3, 'llm.completion', 1200, '{"nodeId":"think","costUsd":0.0125}'),
		($4, $2, $3, 'llm.completion', 10, '{"nodeId":"think","costUsd":"n/a"}'),
		($5, $2, $3, 'llm.completion', 10, '{"nodeId":"think","costUsd":5,"providerSimulated":true}')`,
		"u-"+suffix, h.org, runID, "u2-"+suffix, "u3-"+suffix)
	exec(`INSERT INTO run_events (id, run_id, org_id, node_id, type, payload) VALUES
		($1, $2, $3, 'think', 'agent.tool.started', '{"tool":"http.request","iteration":2}'),
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
	if nodes["form"]["needsYou"] != false {
		t.Fatalf("a form whose resume token expired was offered: %v", nodes["form"])
	}
	if nodes["gate"]["needsYou"] != false || nodes["sign"]["needsYou"] != true {
		t.Fatalf("the requester was asked to approve its own call, or a person step was hidden: %v %v", nodes["gate"], nodes["sign"])
	}
	if nodes["child"]["childRunId"] != "child-ok" || nodes["broken"]["childRunId"] != "child-failed" {
		t.Fatalf("subworkflow child links: %v %v", nodes["child"], nodes["broken"])
	}
	lanes := res.body["lanes"].([]any)
	if len(lanes) != 1 || len(lanes[0].(map[string]any)["steps"].([]any)) != 2 {
		t.Fatalf("agent lane: %v", lanes)
	}
	if step := lanes[0].(map[string]any)["steps"].([]any)[0].(map[string]any); step["iteration"] != 2.0 {
		t.Fatalf("agent lane step lost its iteration: %v", step)
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
	if kinds := inbox(other); kinds["tool_approval"] != 1 || kinds["approval"] != 1 || kinds["human_form"] != 0 {
		t.Fatalf("approver inbox: %v", kinds)
	}
	if kinds := inbox(viewer); len(kinds) != 0 {
		t.Fatalf("a viewer was asked to decide: %v", kinds)
	}
	if res := h.callWithHeaders("GET", "/runs/"+runID+"/map", nil, "other-org-"+suffix, as(editor)); res.status != 404 && res.status != 403 {
		t.Fatalf("another organization read the run map: %d", res.status)
	}

	// A viewer-rank role granted runs.start still cannot decide: every
	// decision route requires editor rank.
	starter := "starter-" + suffix
	exec(`INSERT INTO org_roles (id, org_id, name, inherits_from, granted_permissions) VALUES ($1, $2, 'starter', 'viewer', '["runs.read","runs.start"]')`,
		"role-"+suffix, h.org)
	exec(`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'starter')`, "m-"+starter, h.org, starter)
	if kinds := inbox(starter); len(kinds) != 0 {
		t.Fatalf("a viewer-rank role was offered decisions: %v", kinds)
	}

	// With a second person required, the agent's creator is not offered its publish request.
	clientID := "client-" + suffix
	exec(`INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
		VALUES ($1, $2, 'agent', ARRAY['read','publish'], decode(md5($1) || md5($2), 'hex'), 'abcd', $3, now() + interval '1 day')`, clientID, h.org, other)
	exec(`INSERT INTO publish_requests (id, org_id, workflow_id, draft_id, qualification_id, reasons, requested_by, on_behalf_of, drafted_by, expires_at)
		VALUES ($1, $2, 'wf', 'draft', 'qual', '{first_publish}', $3, $4, $3, now() + interval '1 day')`, "pub-"+suffix, h.org, "agent:"+clientID, other)
	if kinds := inbox(other); kinds["publish_request"] != 1 {
		t.Fatalf("publish request missing from the creator's inbox: %v", kinds)
	}
	exec(`INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'agents.publishRequiresSecondPerson', 'true', 'mcp', 'test', 'boolean')`, "cfg-"+suffix, h.org)
	if kinds := inbox(other); kinds["publish_request"] != 0 {
		t.Fatalf("the creator was offered a request only a second person may approve: %v", kinds)
	}
	if kinds := inbox(editor); kinds["publish_request"] != 1 {
		t.Fatalf("a second person does not see the request: %v", kinds)
	}

	// Approvals the viewer caused, or on runs no longer waiting, never crowd out one they can decide.
	exec(`INSERT INTO runs (id, org_id, workflow_version_id, workflow_id, status, input_json)
		SELECT $1 || g, $2, 'v', 'wf', CASE WHEN g = 0 THEN 'cancelled' ELSE 'running' END, '{}' FROM generate_series(0, 54) g`, "flood-"+suffix+"-", h.org)
	exec(`INSERT INTO run_nodes (id, run_id, org_id, node_id, status, state_json)
		SELECT $1 || g || '-n', $1 || g, $2, 'gate', 'waiting', '{"waiting":{"kind":"tool_approval"}}' FROM generate_series(0, 54) g`, "flood-"+suffix+"-", h.org)
	exec(`INSERT INTO tool_approval_requests (id, org_id, run_id, node_id, tool, params_json, params_digest, requester_ids, expires_at, created_at)
		SELECT $1 || g || '-ta', $2, $1 || g, 'gate', 'http.request', '{}', 'digest', CASE WHEN g = 0 THEN ARRAY[$4] ELSE ARRAY[$3] END,
		       now() + interval '30 minutes', CASE WHEN g = 0 THEN now() + interval '1 minute' ELSE now() - interval '1 hour' END
		FROM generate_series(0, 54) g`, "flood-"+suffix+"-", h.org, other, editor)
	if kinds := inbox(other); kinds["tool_approval"] != 1 {
		t.Fatalf("the approver's decidable tool approval was crowded out or a cancelled run's approval was offered: %v", kinds)
	}
}
