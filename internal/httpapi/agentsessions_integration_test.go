//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

type seededSession struct{ id, clientID string }

// seedAgentSession stores a session with a subagent that is still live after
// a turn stopped, and one Janusly call naming runID. The run, when it exists,
// is marked as started by another agent client of the same creator.
func seedAgentSession(t *testing.T, org, runID string) seededSession {
	t.Helper()
	pool := testPool(t)
	s := seededSession{id: uuid.NewString(), clientID: uuid.NewString()}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
		VALUES ($1, $2, 'Claude Code', '{read,report}', $3, 'abcd', 'creator', now() + interval '1 day')`,
		s.clientID, org, []byte(strings.Repeat("d", 16)+s.clientID[:16]))
	starter := uuid.NewString()
	exec(`INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
		VALUES ($1, $2, 'Claude MCP', '{read,operate}', $3, 'efgh', 'creator', now() + interval '1 day')`,
		starter, org, []byte(strings.Repeat("e", 16)+starter[:16]))
	exec(`UPDATE runs SET created_by = 'agent:' || $1 WHERE org_id = $2 AND id = $3`, starter, org, runID)
	exec(`INSERT INTO agent_sessions (id, org_id, agent_client_id, external_session_id, runtime, project, model, started_at, last_event_at, event_count, last_seq)
		VALUES ($1, $2, $3, $4, 'claude-code', 'billing', 'opus', now() - interval '1 minute', now(), 6, 6)`, s.id, org, s.clientID, "ext-"+s.id)
	at := time.Now().Add(-time.Minute)
	events := []struct {
		typ, agent, parent, agentType, tool, kind, server, status string
		refs                                                      any
	}{
		{"io.janusly.agent.session.started", "", "", "", "", "", "", "", nil},
		{"io.janusly.agent.subagent.started", "sub-1", "", "Explore", "", "", "", "", nil},
		{"io.janusly.agent.tool.completed", "sub-1", "", "Explore", "mcp__notion__search", "mcp", "notion", "ok", nil},
		{"io.janusly.agent.tool.completed", "", "", "", "mcp__janusly__runs.start", "mcp", "janusly", "ok", map[string]any{"runId": runID}},
		{"io.janusly.agent.tool.completed", "", "", "", "Bash", "builtin", "", "error", nil},
		{"io.janusly.agent.turn.stopped", "", "", "", "", "", "", "", nil},
	}
	for i, e := range events {
		var refs []byte
		if e.refs != nil {
			refs, _ = json.Marshal(e.refs)
		}
		null := func(v string) any {
			if v == "" {
				return nil
			}
			return v
		}
		exec(`INSERT INTO agent_session_events (id, org_id, agent_client_id, session_id, event_id, seq, outcome, type,
			agent_id, parent_agent_id, agent_type, tool, tool_kind, mcp_server, status, janusly_refs, occurred_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'applied', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
			uuid.NewString(), org, s.clientID, s.id, fmt.Sprintf("%064x", uuid.New().ID())+"", i+1, e.typ,
			null(e.agent), null(e.parent), null(e.agentType), null(e.tool), null(e.kind), null(e.server), null(e.status),
			refs, at.Add(time.Duration(i)*time.Second))
	}
	return s
}

func seedRun(t *testing.T, org, createdBy string) string {
	t.Helper()
	id := "run-" + uuid.NewString()
	if _, err := testPool(t).Exec(t.Context(), `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json, created_by)
		VALUES ($1, $2, 'v-seed', 'succeeded', '{}', $3)`, id, org, createdBy); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAgentSessionMapNestsSubagentsAndLinksRuns(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	runID := seedRun(t, h.org, "")
	s := seedAgentSession(t, h.org, runID)

	listed := h.call("GET", "/agent-sessions", nil, "")
	sessions, _ := listed.body["sessions"].([]any)
	if listed.status != 200 || len(sessions) == 0 || sessions[0].(map[string]any)["id"] != s.id {
		t.Fatalf("list: %d %v", listed.status, listed.body)
	}
	got := h.call("GET", "/agent-sessions/"+s.id+"/map", nil, "")
	if got.status != 200 {
		t.Fatalf("map: %d %v", got.status, got.body)
	}
	session := got.body["session"].(map[string]any)
	// A stopped turn with a live subagent is still running.
	if session["status"] != "running" || got.body["liveSubagents"] != float64(1) {
		t.Fatalf("status %v live %v", session["status"], got.body["liveSubagents"])
	}
	lanes := got.body["lanes"].([]any)
	if len(lanes) != 2 {
		t.Fatalf("lanes: %v", lanes)
	}
	sub := lanes[1].(map[string]any)
	if sub["nodeId"] != "sub-1" || sub["kind"] != "external_subagent" || sub["parentId"] != "main" || sub["agentType"] != "Explore" {
		t.Fatalf("subagent lane: %v", sub)
	}
	totals := got.body["totals"].(map[string]any)
	if totals["toolCalls"] != float64(3) || totals["mcpCalls"] != float64(2) || totals["errors"] != float64(1) {
		t.Fatalf("totals: %v", totals)
	}
	if refs := got.body["refs"].(map[string]any); fmt.Sprint(refs["runIds"]) != "["+runID+"]" {
		t.Fatalf("refs: %v", refs)
	}

	linked := h.call("GET", "/runs/"+runID+"/map", nil, "")
	if sessions, _ := linked.body["sessions"].([]any); linked.status != 200 || len(sessions) != 1 {
		t.Fatalf("run map link: %d %v", linked.status, linked.body["sessions"])
	}

	pool := testPool(t)
	if _, err := pool.Exec(t.Context(), `UPDATE agent_sessions SET last_event_at = now() - interval '31 minutes' WHERE id = $1`, s.id); err != nil {
		t.Fatal(err)
	}
	if idle := h.call("GET", "/agent-sessions/"+s.id+"/map", nil, ""); idle.body["session"].(map[string]any)["status"] != "idle" {
		t.Fatalf("silent session: %v", idle.body["session"])
	}
}

// Isolation: another organization's session answers as missing and never
// appears in the list; a role without runs.read and an agent token read nothing.
func TestAgentSessionReadsAreIsolated(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	other := "other-org-" + uuid.NewString()[:8]
	foreign := seedAgentSession(t, other, "run-"+uuid.NewString())
	mine := seedAgentSession(t, h.org, "run-"+uuid.NewString())

	if res := h.call("GET", "/agent-sessions/"+foreign.id+"/map", nil, ""); res.status != 404 {
		t.Fatalf("foreign session: %d %v", res.status, res.body)
	}
	listed := h.call("GET", "/agent-sessions?limit=100", nil, "")
	raw, _ := json.Marshal(listed.body)
	if strings.Contains(string(raw), foreign.id) || !strings.Contains(string(raw), mine.id) {
		t.Fatalf("list crossed organizations: %s", raw)
	}
	if res := h.call("GET", "/agent-sessions/"+mine.id+"/map", nil, other); res.status != 403 && res.status != 404 {
		t.Fatalf("another organization header reached the session: %d", res.status)
	}
	if res := h.callWithHeaders("GET", "/agent-sessions", nil, "", map[string]string{
		"Authorization": "Bearer jly_agent_" + strings.Repeat("A", 43),
	}); res.status != 401 && res.status != 403 {
		t.Fatalf("agent token read sessions: %d", res.status)
	}
	if res := h.call("GET", "/agent-sessions?cursor=bm9wZQ", nil, ""); res.status != 400 {
		t.Fatalf("bad cursor: %d", res.status)
	}
	if res := h.call("GET", "/agent-sessions/bad%00id/map", nil, ""); res.status != 404 {
		t.Fatalf("malformed session id: %d", res.status)
	}
	if res := h.call("GET", "/agent-sessions?limit=0", nil, ""); res.status != 400 {
		t.Fatalf("bad limit: %d", res.status)
	}
}

// A session reports its Janusly references itself: a run another person's
// agent started is neither linked from the run map nor listed on the session.
func TestAgentSessionRunLinkRequiresTheSameCreatorsAgent(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	foreignStarter := uuid.NewString()
	if _, err := testPool(t).Exec(t.Context(), `INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
		VALUES ($1, $2, 'someone else', '{read,operate}', $3, 'wxyz', 'another-person', now() + interval '1 day')`,
		foreignStarter, h.org, []byte(strings.Repeat("f", 16)+foreignStarter[:16])); err != nil {
		t.Fatal(err)
	}
	for name, runID := range map[string]string{
		"a person's run":         seedRun(t, h.org, "some-user"),
		"another person's agent": seedRun(t, h.org, "agent:"+foreignStarter),
	} {
		s := seedAgentSession(t, h.org, "")
		if _, err := testPool(t).Exec(t.Context(), `UPDATE agent_session_events SET janusly_refs = jsonb_build_object('runId', $1::text)
			WHERE session_id = $2 AND janusly_refs IS NOT NULL`, runID, s.id); err != nil {
			t.Fatal(err)
		}
		if res := h.call("GET", "/runs/"+runID+"/map", nil, ""); len(res.body["sessions"].([]any)) != 0 {
			t.Fatalf("%s: run map linked an unverified session: %v", name, res.body["sessions"])
		}
		if res := h.call("GET", "/agent-sessions/"+s.id+"/map", nil, ""); fmt.Sprint(res.body["refs"].(map[string]any)["runIds"]) != "[]" {
			t.Fatalf("%s: session listed an unverified run: %v", name, res.body["refs"])
		}
	}
}

// Sessions name agent clients: without agents.read a member reads no session
// and the run map links none.
func TestAgentSessionsRequireAgentsRead(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	runID := seedRun(t, h.org, "")
	s := seedAgentSession(t, h.org, runID)
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_roles(id, org_id, name, inherits_from, granted_permissions)
		VALUES($1, $2, 'runs-only', 'viewer', '["runs.read"]'::jsonb)`, h.org+"-runs-only", h.org); err != nil {
		t.Fatal(err)
	}
	seedMemberRow(t, pool, h.org, "runs-only-user", "runs-only@example.test", "runs-only")
	as := map[string]string{"x-user-id": "runs-only-user"}
	for _, path := range []string{"/agent-sessions", "/agent-sessions/" + s.id + "/map"} {
		if res := h.callWithHeaders("GET", path, nil, "", as); res.status != 403 {
			t.Fatalf("%s without agents.read: %d %v", path, res.status, res.body)
		}
	}
	res := h.callWithHeaders("GET", "/runs/"+runID+"/map", nil, "", as)
	if res.status != 200 || len(res.body["sessions"].([]any)) != 0 {
		t.Fatalf("run map without agents.read: %d %v", res.status, res.body["sessions"])
	}
}

func seedGate(t *testing.T, org string, s seededSession, withContent bool) string {
	t.Helper()
	id := uuid.NewString()
	var content any
	if withContent {
		content = `{"input":{"charge":"ch_1"}}`
	}
	if _, err := testPool(t).Exec(t.Context(), `INSERT INTO agent_session_gates (id, org_id, agent_client_id, session_id, tool_use_id, tool, mcp_server, content, expires_at)
		VALUES ($1, $2, $3, $4, $5, 'mcp__stripe__create_refund', 'stripe', $6::jsonb, now() + interval '10 minutes')`,
		id, org, s.clientID, s.id, "tu-"+id, content); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAgentGateDecisionIsForPeopleWithinTheOrganization(t *testing.T) {
	t.Setenv("JANUSLY_API_SERVICE_TOKEN", "svc-gate-token")
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	s := seedAgentSession(t, h.org, "")
	other := "other-org-" + uuid.NewString()[:8]
	foreignSession := seedAgentSession(t, other, "")
	foreignGate := seedGate(t, other, foreignSession, false)
	for user, role := range map[string]string{"gate-editor": "editor", "gate-viewer": "viewer", "creator": "editor"} {
		seedMemberRow(t, pool, h.org, user, user+"@example.test", role)
	}
	as := func(user string) map[string]string { return map[string]string{"x-user-id": user} }
	approve := map[string]any{"decision": "approve"}

	gate := seedGate(t, h.org, s, true)
	path := "/agent-sessions/gates/" + gate + "/decide"
	if res := h.callWithHeaders("POST", path, approve, "", as("gate-viewer")); res.status != 403 {
		t.Fatalf("viewer decided: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", path, approve, "", map[string]string{"x-user-id": "gate-editor", "Authorization": "Bearer svc-gate-token"}); res.status != 403 || res.body["code"] != "person_required" {
		t.Fatalf("service token decided: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", path, approve, "", map[string]string{"Authorization": "Bearer jly_agent_" + strings.Repeat("A", 43)}); res.status != 401 && res.status != 403 {
		t.Fatalf("agent token decided: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/agent-sessions/gates/"+foreignGate+"/decide", approve, "", as("gate-editor")); res.status != 404 {
		t.Fatalf("another organization's gate: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", path, map[string]any{"decision": "allow"}, "", as("gate-editor")); res.status != 400 {
		t.Fatalf("unknown decision: %d", res.status)
	}

	// The map shows the gate with its captured input and offers the decision.
	mapped := h.callWithHeaders("GET", "/agent-sessions/"+s.id+"/map", nil, "", as("gate-editor"))
	gates, _ := mapped.body["gates"].([]any)
	if len(gates) != 1 || gates[0].(map[string]any)["needsYou"] != true || gates[0].(map[string]any)["contentCaptured"] != true ||
		fmt.Sprint(gates[0].(map[string]any)["input"]) != "map[charge:ch_1]" {
		t.Fatalf("map gates: %v", mapped.body["gates"])
	}
	viewerGate := h.callWithHeaders("GET", "/agent-sessions/"+s.id+"/map", nil, "", as("gate-viewer")).body["gates"].([]any)[0].(map[string]any)
	if viewerGate["needsYou"] != false || viewerGate["input"] != nil || viewerGate["contentCaptured"] != true {
		t.Fatalf("a viewer was offered the decision or shown the captured input: %v", viewerGate)
	}
	inbox := h.callWithHeaders("GET", "/needs-you", nil, "", as("gate-editor"))
	raw, _ := json.Marshal(inbox.body)
	if !strings.Contains(string(raw), `"kind":"agent_gate"`) || !strings.Contains(string(raw), gate) || strings.Contains(string(raw), foreignGate) || strings.Contains(string(raw), "ch_1") {
		t.Fatalf("needs-you: %s", raw)
	}

	// The creator may decide their own agent's gate by default.
	if res := h.callWithHeaders("POST", path, map[string]any{"decision": "deny", "reason": "wrong customer"}, "", as("creator")); res.status != 200 {
		t.Fatalf("creator decision: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", path, approve, "", as("gate-editor")); res.status != 409 {
		t.Fatalf("second decision: %d %v", res.status, res.body)
	}
	var status, decidedBy, metadata string
	if err := pool.QueryRow(t.Context(), `SELECT g.status, g.decided_by, (SELECT metadata::text FROM audit_logs WHERE org_id = g.org_id AND target_id = g.id AND action = 'agent_gate.decided')
		FROM agent_session_gates g WHERE g.id = $1`, gate).Scan(&status, &decidedBy, &metadata); err != nil {
		t.Fatal(err)
	}
	if status != "denied" || decidedBy != "creator" || !strings.Contains(metadata, "mcp__stripe__create_refund") || strings.Contains(metadata, "ch_1") {
		t.Fatalf("stored decision: %s %s %s", status, decidedBy, metadata)
	}

	// With the second-person rule the creator neither decides nor is asked.
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'agents.publishRequiresSecondPerson', 'true', 'mcp', 'test', 'boolean')`, uuid.NewString(), h.org); err != nil {
		t.Fatal(err)
	}
	second := seedGate(t, h.org, s, false)
	secondPath := "/agent-sessions/gates/" + second + "/decide"
	if res := h.callWithHeaders("POST", secondPath, approve, "", as("creator")); res.status != 403 || res.body["code"] != "agent_gate_self_decision" {
		t.Fatalf("creator under the second-person rule: %d %v", res.status, res.body)
	}
	creatorInbox, _ := json.Marshal(h.callWithHeaders("GET", "/needs-you", nil, "", as("creator")).body)
	if strings.Contains(string(creatorInbox), second) {
		t.Fatalf("needs-you offered the creator a gate they cannot decide: %s", creatorInbox)
	}
	// An expired gate cannot be approved.
	if _, err := pool.Exec(t.Context(), `UPDATE agent_session_gates SET expires_at = now() - interval '1 second' WHERE id = $1`, second); err != nil {
		t.Fatal(err)
	}
	if res := h.callWithHeaders("POST", secondPath, approve, "", as("gate-editor")); res.status != 409 {
		t.Fatalf("expired gate approved: %d %v", res.status, res.body)
	}
}

func TestAgentSessionConvertsIntoADraftThatTheGateRefusesUntilFilledIn(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	s := seedAgentSession(t, h.org, "")
	other := "other-org-" + uuid.NewString()[:8]
	foreign := seedAgentSession(t, other, "")
	seedMemberRow(t, pool, h.org, "draft-viewer", "draft-viewer@example.test", "viewer")

	mapped := h.call("GET", "/agent-sessions/"+s.id+"/map", nil, "")
	conversion := mapped.body["conversion"].(map[string]any)
	// Three tool calls: one MCP call converts; the Bash call and the Janusly call do not.
	if conversion["totalSteps"] != float64(3) || conversion["convertibleSteps"] != float64(1) || conversion["convertible"] != true {
		t.Fatalf("conversion preview: %v", conversion)
	}
	if res := h.callWithHeaders("POST", "/agent-sessions/"+s.id+"/draft", nil, "", map[string]string{"x-user-id": "draft-viewer"}); res.status != 403 {
		t.Fatalf("viewer converted: %d %v", res.status, res.body)
	}
	if res := h.call("POST", "/agent-sessions/"+foreign.id+"/draft", nil, ""); res.status != 404 {
		t.Fatalf("another organization's session converted: %d %v", res.status, res.body)
	}

	created := h.call("POST", "/agent-sessions/"+s.id+"/draft", nil, "")
	draftID, _ := created.body["draftId"].(string)
	workflowID, _ := created.body["workflowId"].(string)
	if created.status != 201 || !strings.HasPrefix(draftID, "draft_") || !strings.HasPrefix(workflowID, "wf_") ||
		fmt.Sprint(created.body["placeholders"]) != "[/nodes/agent_1/config/goal /outputs/result]" {
		t.Fatalf("convert: %d %v", created.status, created.body)
	}
	var document, origin, createdBy string
	var versions, audited int
	if err := pool.QueryRow(t.Context(), `SELECT d.document::text, d.origin::text, d.created_by,
		(SELECT count(*) FROM workflow_versions v WHERE v.org_id = d.org_id AND v.workflow_id = d.workflow_id),
		(SELECT count(*) FROM audit_logs a WHERE a.org_id = d.org_id AND a.action = 'agent_session.converted' AND a.target_id = $2)
		FROM workflow_drafts d WHERE d.org_id = $1 AND d.id = $3`, h.org, s.id, draftID).Scan(&document, &origin, &createdBy, &versions, &audited); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(origin, s.id) || !strings.Contains(origin, "observed_session") || versions != 0 || audited != 1 ||
		!strings.Contains(document, "observed_placeholder:") || strings.Contains(document, "mcp__") ||
		strings.Contains(document, "Bash") || !strings.Contains(fmt.Sprint(created.body["agents"]), "mcp__notion__search") {
		t.Fatalf("stored draft: origin %s versions %d audited %d document %s", origin, versions, audited, document)
	}

	// Converting again returns the same draft: no second workflow, no second audit row.
	again := h.call("POST", "/agent-sessions/"+s.id+"/draft", nil, "")
	var drafts int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM workflow_drafts WHERE org_id = $1 AND origin->>'sessionId' = $2`, h.org, s.id).Scan(&drafts); err != nil {
		t.Fatal(err)
	}
	if again.status != 200 || again.body["draftId"] != draftID || drafts != 1 {
		t.Fatalf("second conversion: %d %v (%d drafts)", again.status, again.body["draftId"], drafts)
	}

	// A session with no MCP tool calls says so instead of producing an empty workflow.
	if _, err := pool.Exec(t.Context(), `DELETE FROM workflow_drafts WHERE org_id = $1 AND id = $2`, h.org, draftID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE agent_session_events SET tool_kind = 'builtin', mcp_server = NULL WHERE session_id = $1`, s.id); err != nil {
		t.Fatal(err)
	}
	if res := h.call("POST", "/agent-sessions/"+s.id+"/draft", nil, ""); res.status != 422 || res.body["code"] != "agent_session_not_convertible" {
		t.Fatalf("coding session: %d %v", res.status, res.body)
	}
}
