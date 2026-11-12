//go:build integration

package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
)

// conformanceAgentClients drives the agent client lifecycle as a signed-in
// editor, with a removed and a reduced creator, recorded tool calls and an
// open publish request, so every optional shape reaches the wire.
func conformanceAgentClients(t *testing.T, h *apiHarness, rec *conformanceRecorder) {
	t.Helper()
	pool := testPool(t)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	editor, viewer := "conformance-agent-editor-"+h.org, "conformance-agent-viewer-"+h.org
	exec(`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor'), ($4, $2, $5, 'viewer')`,
		"m-"+editor, h.org, editor, "m-"+viewer, viewer)
	as := map[string]string{"x-user-id": editor}

	issued := rec.record("POST /v1/agent-clients", h.callWithHeaders("POST", "/v1/agent-clients", map[string]any{
		"name": "Conformance agent", "capabilities": []string{"propose", "test"},
		"scope": map[string]any{"tags": []string{"billing"}}, "expiresInDays": 7,
	}, "", as), http.StatusCreated)
	clientID := issued["client"].(map[string]any)["id"].(string)
	rec.record("POST /v1/agent-clients/{id}/rotate", h.callWithHeaders("POST", "/v1/agent-clients/"+clientID+"/rotate",
		map[string]any{"expiresInDays": 3}, "", as), http.StatusOK)

	for index, creator := range []string{viewer, "conformance-agent-gone-" + h.org} {
		exec(`INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
			VALUES ($1, $2, 'Seeded agent', ARRAY['read','propose'], sha256($3::bytea), 'abcd', $4, now() + interval '1 day')`,
			"conformance-seeded-"+string(rune('a'+index))+"-"+h.org, h.org, clientID+creator, creator)
	}
	agent := "agent:" + clientID
	for _, metadata := range []string{
		`{"allowed": true, "permissions": ["workflows.read"]}`,
		`{"allowed": false, "denial": "capability_missing"}`,
	} {
		var decoded map[string]any
		_ = json.Unmarshal([]byte(metadata), &decoded)
		decoded["agentClient"] = map[string]any{"id": clientID, "name": "Conformance agent"}
		raw, _ := json.Marshal(decoded)
		exec(`INSERT INTO audit_logs (id, org_id, user_id, action, target_type, target_id, metadata)
			VALUES (gen_random_uuid()::text, $1, $2, 'mcp.tool.invoked', 'mcp_tool', 'workflows.list', $3)`, h.org, agent, raw)
	}
	workflowID := "conformance-agent-workflow-" + h.org
	document, _ := json.Marshal(makeLinearWorkflow(workflowID))
	exec(`INSERT INTO workflow_drafts (id, org_id, workflow_id, document, digest, created_by)
		VALUES ($1, $2, $3, $4, repeat('c', 64), $5)`, "draft-agent-"+h.org, h.org, workflowID, document, agent)
	exec(`INSERT INTO draft_qualifications (id, org_id, draft_id, digest, status, checks, fixture_runs, created_by, completed_at)
		VALUES ($1, $2, $3, repeat('c', 64), 'passed', '[]', '[]', $4, now())`, "qual-agent-"+h.org, h.org, "draft-agent-"+h.org, agent)
	exec(`INSERT INTO publish_requests (id, org_id, workflow_id, draft_id, qualification_id, reasons, requested_by, on_behalf_of, drafted_by, expires_at)
		VALUES ($1, $2, $3, $4, $5, '{first_publish}', $6, $7, $6, now() + interval '1 day')`,
		"pub-agent-"+h.org, h.org, workflowID, "draft-agent-"+h.org, "qual-agent-"+h.org, agent, editor)

	listed := rec.record("GET /v1/agent-clients", h.callWithHeaders("GET", "/v1/agent-clients", nil, "", as), http.StatusOK)
	states := map[string]bool{}
	for _, raw := range listed["clients"].([]any) {
		states[raw.(map[string]any)["creatorAccess"].(map[string]any)["state"].(string)] = true
	}
	if !states["member"] || !states["reduced"] || !states["removed"] {
		t.Fatalf("list must render every creator state: %v", states)
	}
	detail := rec.record("GET /v1/agent-clients/{id}", h.callWithHeaders("GET", "/v1/agent-clients/"+clientID, nil, "", as), http.StatusOK)
	if len(detail["recentCalls"].([]any)) != 2 || len(detail["openRequests"].([]any)) != 1 {
		t.Fatalf("detail must carry the seeded calls and request: %+v", detail)
	}
	rec.record("POST /v1/agent-clients/{id}/revoke", h.callWithHeaders("POST", "/v1/agent-clients/"+clientID+"/revoke", nil, "", as), http.StatusOK)
	rec.record("GET /v1/agent-clients", h.callWithHeaders("GET", "/v1/agent-clients?limit=1", nil, "", as), http.StatusOK)
}
