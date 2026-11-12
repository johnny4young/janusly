//go:build integration

package mcpserver

import (
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentclient"
)

// seedObservedSession stores a session of the client with two overlapping
// subagents that called MCP tools.
func seedObservedSession(t *testing.T, pool *pgxpool.Pool, org, clientID string) string {
	t.Helper()
	id := uuid.NewString()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO agent_sessions (id, org_id, agent_client_id, external_session_id, runtime, project, started_at, last_event_at, event_count, last_seq)
		VALUES ($1, $2, $3, $4, 'claude-code', 'billing', now() - interval '1 minute', now(), 4, 4)`, id, org, clientID, "ext-"+id)
	for i, call := range []struct {
		agent, tool, server string
		second              int
	}{
		{"a", "mcp__stripe__list_charges", "stripe", 0}, {"b", "mcp__slack__post_message", "slack", 2},
		{"a", "mcp__stripe__get_charge", "stripe", 5}, {"b", "mcp__slack__post_message", "slack", 6},
	} {
		exec(`INSERT INTO agent_session_events (id, org_id, agent_client_id, session_id, event_id, seq, outcome, type, agent_id, tool, tool_kind, mcp_server, status, occurred_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'applied', 'io.janusly.agent.tool.completed', $7, $8, 'mcp', $9, 'ok', now() - interval '1 minute' + make_interval(secs => $10))`,
			uuid.NewString(), org, clientID, id, strings.Repeat(fmt.Sprintf("%x", i+1), 64), i+1, call.agent, call.tool, call.server, call.second)
	}
	return id
}

func TestAgentConvertsOnlyItsOwnSessionsAndTheGateRefusesPlaceholders(t *testing.T) {
	pool, eng := agentTestPool(t)
	home, away := seedAgentTenant(t, pool, eng, "home"), seedAgentTenant(t, pool, eng, "away")
	author := issueAgentClient(t, pool, home, agentclient.IssueInput{Capabilities: []string{"propose", "test", "report"}})
	peer := issueAgentClient(t, pool, home, agentclient.IssueInput{Capabilities: []string{"propose", "report"}})
	foreign := issueAgentClient(t, pool, away, agentclient.IssueInput{Capabilities: []string{"propose", "report"}})
	reader := issueAgentClient(t, pool, home, agentclient.IssueInput{Capabilities: []string{"read", "report"}})
	mine := seedObservedSession(t, pool, home.org, author.Client.ID)
	peers := seedObservedSession(t, pool, home.org, peer.Client.ID)
	foreigns := seedObservedSession(t, pool, away.org, foreign.Client.ID)
	session := agentSession(t, pool, eng, author.Token)

	// Another client's session, another organization's and one that exists
	// nowhere all read the same.
	var refusals []string
	for _, id := range []string{peers, foreigns, uuid.NewString()} {
		ok, _, text := gateCall(t, session, "sessions.to_draft", map[string]any{"sessionId": id})
		if ok {
			t.Fatalf("converted a session of another client: %s", text)
		}
		refusals = append(refusals, text)
	}
	if refusals[0] != refusals[1] || refusals[1] != refusals[2] || !strings.Contains(refusals[0], "not_found") {
		t.Fatalf("refusals differ, so they reveal which sessions exist: %v", refusals)
	}
	if ok, _, text := gateCall(t, agentSession(t, pool, eng, reader.Token), "sessions.to_draft", map[string]any{"sessionId": mine}); ok {
		t.Fatalf("a client without propose converted: %s", text)
	}

	ok, saved, text := gateCall(t, session, "sessions.to_draft", map[string]any{"sessionId": mine})
	if !ok {
		t.Fatalf("sessions.to_draft: %s", text)
	}
	draftID, _ := saved["draftId"].(string)
	conversion, _ := saved["conversion"].(map[string]any)
	if draftID == "" || conversion["convertibleSteps"] != float64(4) || len(saved["placeholders"].([]any)) != 3 ||
		fmt.Sprint(saved["mcpServers"]) != "[slack stripe]" {
		t.Fatalf("saved: %v", saved)
	}
	ok, draft, text := gateCall(t, session, "drafts.get", map[string]any{"draftId": draftID})
	if !ok || !strings.Contains(text, "parallel_fork") || !strings.Contains(text, "observed_placeholder:") {
		t.Fatalf("draft document: %v %s", draft, text)
	}
	var createdBy, origin string
	var audited int
	if err := pool.QueryRow(t.Context(), `SELECT created_by, origin::text, (SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'agent_session.converted' AND target_id = $3)
		FROM workflow_drafts WHERE org_id = $1 AND id = $2`, home.org, draftID, mine).Scan(&createdBy, &origin, &audited); err != nil {
		t.Fatal(err)
	}
	if createdBy != "agent:"+author.Client.ID || !strings.Contains(origin, mine) || audited != 1 {
		t.Fatalf("draft row: %s %s %d", createdBy, origin, audited)
	}

	// Qualification fails on every placeholder, so nothing publishes as observed.
	ok, receipt, text := gateCall(t, session, "workflows.qualify", map[string]any{"draftId": draftID})
	if !ok && !strings.Contains(text, "observed_placeholder") {
		t.Fatalf("qualify: %s", text)
	}
	if ok {
		settled := receipt
		if id, _ := receipt["qualificationId"].(string); id != "" && receipt["status"] == "running" {
			settled = waitQualification(t, session, id)
		}
		if settled["status"] == "passed" || !strings.Contains(fmt.Sprint(settled["checks"]), "observed_placeholder") {
			t.Fatalf("a draft with placeholders qualified: %v", settled)
		}
	}
	if ok, _, text := gateCall(t, session, "workflows.publish", map[string]any{"draftId": draftID}); ok && !strings.Contains(text, "approval_required") {
		t.Fatalf("an unqualified observed draft published: %s", text)
	}
}
