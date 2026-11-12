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
// a turn stopped, and one Janusly call naming runID.
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

func TestAgentSessionMapNestsSubagentsAndLinksRuns(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	runID := "run-" + uuid.NewString()
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
	if res := h.call("GET", "/agent-sessions?limit=0", nil, ""); res.status != 400 {
		t.Fatalf("bad limit: %d", res.status)
	}
}
