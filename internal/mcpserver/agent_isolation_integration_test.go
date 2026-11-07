//go:build integration

package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/store"
)

// agentTenant is one organization seeded with every resource kind an agent
// tool can name.
type agentTenant struct {
	org, creator                    string
	workflowID, versionID           string
	otherWorkflowID                 string
	runID, otherRunID, deadLetterID string
	caseID                          string
}

func agentTestPool(t *testing.T) (*pgxpool.Pool, *engine.Engine) {
	t.Helper()
	if os.Getenv("JANUSLY_DATABASE_URL") == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "true")
	pool := poolForTest(t)
	return pool, engine.New(pool)
}

func seedAgentTenant(t *testing.T, pool *pgxpool.Pool, eng *engine.Engine, label string) agentTenant {
	t.Helper()
	ctx := t.Context()
	suffix := uuid.NewString()[:8]
	tenant := agentTenant{org: "agent-" + label + "-" + suffix, creator: label + "-creator-" + suffix}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %s: %v", label, err)
		}
	}
	exec(`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'admin')`,
		uuid.NewString(), tenant.org, tenant.creator)
	exec(`INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'mcp.writeConsent', 'true', 'mcp', 'test consent', 'boolean')`, uuid.NewString(), tenant.org)
	save := func(id string) string {
		t.Helper()
		saved, err := eng.SaveWorkflowVersion(ctx, engine.SaveWorkflowVersionInput{
			OrgID: tenant.org, UserID: tenant.creator, NewID: uuid.NewString,
			Workflow: &domain.Workflow{ID: id, Name: label + " " + id, DSLVersion: "1.0",
				Nodes: []domain.Node{{ID: "only", Type: "noop", Config: map[string]any{}}}, Edges: []domain.Edge{}},
		})
		if err != nil {
			t.Fatalf("save %s: %v", id, err)
		}
		return saved.VersionID
	}
	tenant.workflowID = tenant.org + "-billing"
	tenant.versionID = save(tenant.workflowID)
	tenant.otherWorkflowID = tenant.org + "-other"
	otherVersionID := save(tenant.otherWorkflowID)
	exec(`INSERT INTO workflow_metadata (id, org_id, workflow_id, tags) VALUES ($1, $2, $3, '["billing"]')`,
		uuid.NewString(), tenant.org, tenant.workflowID)

	tenant.runID, tenant.otherRunID = "run-"+uuid.NewString(), "run-"+uuid.NewString()
	exec(`INSERT INTO runs (id, org_id, workflow_version_id, workflow_id, status, input_json, output_json)
		VALUES ($1, $2, $3, $4, 'failed', '{}', '{"total":"10"}')`, tenant.runID, tenant.org, tenant.versionID, tenant.workflowID)
	exec(`INSERT INTO runs (id, org_id, workflow_version_id, workflow_id, status, input_json)
		VALUES ($1, $2, $3, $4, 'running', '{}')`, tenant.otherRunID, tenant.org, otherVersionID, tenant.otherWorkflowID)
	tenant.deadLetterID = "dl-" + uuid.NewString()
	exec(`INSERT INTO dead_letters (id, org_id, run_id, node_id, workflow_json, node_json, error_json)
		VALUES ($1, $2, $3, 'only', '{}', '{"type":"noop"}', '{"message":"boom"}')`, tenant.deadLetterID, tenant.org, tenant.runID)
	tenant.caseID = "case-" + uuid.NewString()
	exec(`INSERT INTO recovery_cases
		(id, org_id, run_id, workflow_id, workflow_version_id, source, detector_id, source_node_id, detector_kind, action, message, state, revision)
		VALUES ($1, $2, $3, $4, $5, 'semantic_violation', 'det', 'only', 'expression', 'quarantine', 'seed', 'contained', 1)`,
		tenant.caseID, tenant.org, tenant.runID, tenant.workflowID, tenant.versionID)
	return tenant
}

func issueAgentClient(t *testing.T, pool *pgxpool.Pool, tenant agentTenant, in agentclient.IssueInput) agentclient.Issued {
	t.Helper()
	q := store.New(pool)
	held, err := agentclient.CreatorPermissions(t.Context(), q, tenant.org, tenant.creator)
	if err != nil || held == nil {
		t.Fatalf("creator permissions: %v %v", held, err)
	}
	in.OrgID, in.CreatedBy = tenant.org, tenant.creator
	if in.Name == "" {
		in.Name = "test agent"
	}
	issued, err := agentclient.Issue(t.Context(), q, uuid.NewString(), time.Now(), in, held)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return issued
}

func agentSession(t *testing.T, pool *pgxpool.Pool, eng *engine.Engine, token string) *mcp.ClientSession {
	t.Helper()
	resolver := agentclient.Resolver{Pool: pool}
	server := NewServer(Deps{
		Engine: eng, Pool: pool, NewID: uuid.NewString, Transport: "stdio",
		ResolveActor: func(ctx context.Context, _ mcp.Request) (*agentclient.Principal, error) {
			return resolver.Resolve(ctx, token)
		},
	})
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = server.Run(context.Background(), serverTransport)
	}()
	client := mcp.NewClient(&mcp.Implementation{Name: "agent-isolation", Version: "1"}, nil)
	session, err := client.Connect(t.Context(), clientTransport, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close(); <-done })
	return session
}

func resultText(res *mcp.CallToolResult) string {
	if res == nil || len(res.Content) == 0 {
		return ""
	}
	text, _ := res.Content[0].(*mcp.TextContent)
	if text == nil {
		return ""
	}
	return text.Text
}

// TestAgentClientCannotReachAnotherOrganization calls every agent tool with
// another organization's real ids and with ids that exist nowhere: the two
// answers must be identical errors, so an agent learns nothing about a
// tenant it does not belong to.
func TestAgentClientCannotReachAnotherOrganization(t *testing.T) {
	pool, eng := agentTestPool(t)
	home := seedAgentTenant(t, pool, eng, "home")
	foreign := seedAgentTenant(t, pool, eng, "foreign")
	issued := issueAgentClient(t, pool, home, agentclient.IssueInput{Capabilities: []string{"read", "operate"}})
	session := agentSession(t, pool, eng, issued.Token)

	missing := "missing-" + uuid.NewString()
	byID := func(foreignArgs, missingArgs map[string]any) [2]map[string]any {
		return [2]map[string]any{foreignArgs, missingArgs}
	}
	cases := map[string][2]map[string]any{
		"workflows.get":        byID(map[string]any{"workflowId": foreign.workflowID}, map[string]any{"workflowId": missing}),
		"workflows.assure":     byID(map[string]any{"workflowId": foreign.workflowID}, map[string]any{"workflowId": missing}),
		"workflows.deactivate": byID(map[string]any{"workflowId": foreign.workflowID}, map[string]any{"workflowId": missing}),
		"workflows.reactivate": byID(map[string]any{"workflowId": foreign.workflowID}, map[string]any{"workflowId": missing}),
		"workflows.rollback": byID(
			map[string]any{"workflowId": foreign.workflowID, "sourceVersionId": foreign.versionID},
			map[string]any{"workflowId": missing, "sourceVersionId": missing}),
		"runs.start":             byID(map[string]any{"workflowId": foreign.workflowID}, map[string]any{"workflowId": missing}),
		"runs.status":            byID(map[string]any{"runId": foreign.runID}, map[string]any{"runId": missing}),
		"runs.inspect":           byID(map[string]any{"runId": foreign.runID}, map[string]any{"runId": missing}),
		"runs.output":            byID(map[string]any{"runId": foreign.runID}, map[string]any{"runId": missing}),
		"runs.cancel":            byID(map[string]any{"runId": foreign.otherRunID}, map[string]any{"runId": missing}),
		"dlq.redrive":            byID(map[string]any{"deadLetterId": foreign.deadLetterID}, map[string]any{"deadLetterId": missing}),
		"recovery.cases.inspect": byID(map[string]any{"caseId": foreign.caseID}, map[string]any{"caseId": missing}),
		"recovery.cases.diagnose": byID(
			map[string]any{"caseId": foreign.caseID, "expectedRevision": 1},
			map[string]any{"caseId": missing, "expectedRevision": 1}),
		"recovery.cases.validate": byID(
			map[string]any{"caseId": foreign.caseID, "expectedRevision": 1, "candidateArtifactId": "candidate"},
			map[string]any{"caseId": missing, "expectedRevision": 1, "candidateArtifactId": "candidate"}),
		"recovery.cases.apply": byID(
			map[string]any{"caseId": foreign.caseID, "expectedRevision": 1, "candidateArtifactId": "candidate", "validationArtifactId": "validation"},
			map[string]any{"caseId": missing, "expectedRevision": 1, "candidateArtifactId": "candidate", "validationArtifactId": "validation"}),
	}
	// Tools without a resource id are checked by what their results leak.
	noForeignInput := map[string]bool{
		"agent.info": true, "catalog.describe": true, "workflows.validate": true, "operations.brief": true,
		"workflows.list": true, "runs.list": true, "dlq.list": true,
	}
	for _, tool := range allAgentTools() {
		if _, ok := cases[tool]; !ok && !noForeignInput[tool] {
			t.Fatalf("%s has no isolation case; add one before exposing it to agents", tool)
		}
	}

	for tool, args := range cases {
		foreignRes, _ := callTool(t, session, tool, args[0])
		missingRes, _ := callTool(t, session, tool, args[1])
		if !foreignRes.IsError || !missingRes.IsError || resultText(foreignRes) != resultText(missingRes) {
			t.Fatalf("%s distinguishes a foreign id from a missing one:\nforeign: %v %q\nmissing: %v %q",
				tool, foreignRes.IsError, resultText(foreignRes), missingRes.IsError, resultText(missingRes))
		}
	}

	leaks := func(tool string, args map[string]any) string {
		t.Helper()
		res, _ := callTool(t, session, tool, args)
		raw, _ := json.Marshal(res.StructuredContent)
		text := resultText(res) + string(raw)
		for _, id := range []string{foreign.org, foreign.workflowID, foreign.otherWorkflowID, foreign.runID, foreign.otherRunID, foreign.deadLetterID, foreign.caseID} {
			if strings.Contains(text, id) {
				t.Fatalf("%s leaked %s: %s", tool, id, text)
			}
		}
		return text
	}
	if text := leaks("workflows.list", map[string]any{"limit": 100}); !strings.Contains(text, home.workflowID) {
		t.Fatalf("workflows.list lost the home workflow: %s", text)
	}
	if text := leaks("runs.list", map[string]any{"limit": 100}); !strings.Contains(text, home.runID) {
		t.Fatalf("runs.list lost the home run: %s", text)
	}
	if text := leaks("dlq.list", map[string]any{"limit": 100}); !strings.Contains(text, home.deadLetterID) {
		t.Fatalf("dlq.list lost the home dead letter: %s", text)
	}
	if text := leaks("runs.list", map[string]any{"workflowId": foreign.workflowID}); strings.Contains(text, "runId") {
		t.Fatalf("filtering by a foreign workflow returned runs: %s", text)
	}
	leaks("catalog.describe", map[string]any{"section": "subworkflows"})
	leaks("operations.brief", map[string]any{})
	if text := leaks("agent.info", map[string]any{}); !strings.Contains(text, home.org) {
		t.Fatalf("agent.info names the wrong organization: %s", text)
	}

	var foreignAudit int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND user_id = $2`,
		foreign.org, "agent:"+issued.Client.ID).Scan(&foreignAudit); err != nil || foreignAudit != 0 {
		t.Fatalf("agent audit rows landed in the foreign organization: %d %v", foreignAudit, err)
	}
	var foreignState string
	if err := pool.QueryRow(t.Context(), `SELECT status FROM runs WHERE id = $1`, foreign.otherRunID).Scan(&foreignState); err != nil || foreignState != "running" {
		t.Fatalf("foreign run changed: %q %v", foreignState, err)
	}
	var foreignStatus string
	if err := pool.QueryRow(t.Context(), `SELECT status FROM workflows WHERE id = $1`, foreign.workflowID).Scan(&foreignStatus); err != nil || foreignStatus != "active" {
		t.Fatalf("foreign workflow changed: %q %v", foreignStatus, err)
	}
}

func TestAgentClientCredentialLifecycleAppliesOnTheNextCall(t *testing.T) {
	pool, eng := agentTestPool(t)
	tenant := seedAgentTenant(t, pool, eng, "lifecycle")
	ctx := t.Context()
	invalid := "agent token is invalid, expired or revoked"
	expectInvalid := func(session *mcp.ClientSession, label string) {
		t.Helper()
		res, _ := callTool(t, session, "agent.info", map[string]any{})
		if !res.IsError || resultText(res) != invalid {
			t.Fatalf("%s: token still works: %q", label, resultText(res))
		}
	}

	revoked := issueAgentClient(t, pool, tenant, agentclient.IssueInput{})
	session := agentSession(t, pool, eng, revoked.Token)
	if res, _ := callTool(t, session, "agent.info", map[string]any{}); res.IsError {
		t.Fatalf("fresh token refused: %q", resultText(res))
	}
	if _, err := store.New(pool).RevokeAgentClient(ctx, store.RevokeAgentClientParams{
		OrgID: tenant.org, ID: revoked.Client.ID, RevokedBy: tenant.creator,
	}); err != nil {
		t.Fatal(err)
	}
	expectInvalid(session, "revoked")

	expired := issueAgentClient(t, pool, tenant, agentclient.IssueInput{})
	if _, err := pool.Exec(ctx, `UPDATE agent_clients SET token_issued_at = now() - interval '2 days',
		expires_at = now() - interval '1 day' WHERE id = $1`, expired.Client.ID); err != nil {
		t.Fatal(err)
	}
	expectInvalid(agentSession(t, pool, eng, expired.Token), "expired")

	rotated := issueAgentClient(t, pool, tenant, agentclient.IssueInput{})
	fresh, err := agentclient.Rotate(ctx, store.New(pool), tenant.org, rotated.Client.ID, time.Now(), 0)
	if err != nil {
		t.Fatal(err)
	}
	expectInvalid(agentSession(t, pool, eng, rotated.Token), "rotated away")
	if res, _ := callTool(t, agentSession(t, pool, eng, fresh.Token), "agent.info", map[string]any{}); res.IsError {
		t.Fatalf("rotated token refused: %q", resultText(res))
	}

	operator := issueAgentClient(t, pool, tenant, agentclient.IssueInput{Capabilities: []string{"operate"}})
	operatorSession := agentSession(t, pool, eng, operator.Token)
	if _, err := pool.Exec(ctx, `UPDATE org_members SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`,
		tenant.org, tenant.creator); err != nil {
		t.Fatal(err)
	}
	res, _ := callTool(t, operatorSession, "runs.start", map[string]any{"workflowId": tenant.workflowID})
	if !res.IsError || !strings.Contains(resultText(res), "lacks permission runs.start") {
		t.Fatalf("demoted creator's agent still starts runs: %q", resultText(res))
	}
	info, payload := callTool(t, operatorSession, "agent.info", map[string]any{})
	if info.IsError || !strings.Contains(fmt.Sprint(payload["missingPermissions"]), "runs.start") {
		t.Fatalf("agent.info hides the demotion: %v", payload)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, tenant.org, tenant.creator); err != nil {
		t.Fatal(err)
	}
	expectInvalid(operatorSession, "creator removed")
}

func TestAgentClientScopeAuditAndRateLimit(t *testing.T) {
	pool, eng := agentTestPool(t)
	tenant := seedAgentTenant(t, pool, eng, "scope")
	issued := issueAgentClient(t, pool, tenant, agentclient.IssueInput{
		Capabilities: []string{"operate"}, ScopeTags: []string{"billing"},
	})
	session := agentSession(t, pool, eng, issued.Token)

	_, listed := callTool(t, session, "workflows.list", map[string]any{})
	raw, _ := json.Marshal(listed)
	if !strings.Contains(string(raw), tenant.workflowID) || strings.Contains(string(raw), tenant.otherWorkflowID) {
		t.Fatalf("scoped workflows.list: %s", raw)
	}
	_, runs := callTool(t, session, "runs.list", map[string]any{})
	raw, _ = json.Marshal(runs)
	if !strings.Contains(string(raw), tenant.runID) || strings.Contains(string(raw), tenant.otherRunID) {
		t.Fatalf("scoped runs.list: %s", raw)
	}
	for tool, args := range map[string][2]map[string]any{
		"workflows.get": {{"workflowId": tenant.otherWorkflowID}, {"workflowId": "missing-" + uuid.NewString()}},
		"runs.status":   {{"runId": tenant.otherRunID}, {"runId": "missing-" + uuid.NewString()}},
		"runs.start":    {{"workflowId": tenant.otherWorkflowID}, {"workflowId": "missing-" + uuid.NewString()}},
	} {
		outside, _ := callTool(t, session, tool, args[0])
		absent, _ := callTool(t, session, tool, args[1])
		if !outside.IsError || resultText(outside) != resultText(absent) {
			t.Fatalf("%s reveals an out-of-scope workflow: %q vs %q", tool, resultText(outside), resultText(absent))
		}
	}
	if res, _ := callTool(t, session, "operations.brief", map[string]any{}); !res.IsError {
		t.Fatal("a scoped client read the organization-wide brief")
	}

	started, payload := callTool(t, session, "runs.start", map[string]any{"workflowId": tenant.workflowID})
	if started.IsError {
		t.Fatalf("in-scope start refused: %q", resultText(started))
	}
	runID, _ := payload["runId"].(string)
	actorID := "agent:" + issued.Client.ID
	var createdBy string
	var agentActors int
	if err := pool.QueryRow(t.Context(), `SELECT created_by,
		(SELECT count(*) FROM run_actors WHERE run_id = r.id AND role = 'agent' AND actor = $2)
		FROM runs r WHERE id = $1`, runID, tenant.creator).Scan(&createdBy, &agentActors); err != nil {
		t.Fatal(err)
	}
	if createdBy != actorID || agentActors != 1 {
		t.Fatalf("run attribution: created_by=%q agent actors=%d", createdBy, agentActors)
	}
	var invoked int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND user_id = $2 AND action = 'mcp.tool.invoked'
		  AND metadata->'agentClient'->>'id' = $3 AND metadata->>'onBehalfOf' = $4
		  AND metadata->>'transport' = 'stdio' AND metadata->'actor'->>'agentClientId' = $3`,
		tenant.org, actorID, issued.Client.ID, tenant.creator).Scan(&invoked); err != nil || invoked == 0 {
		t.Fatalf("tool calls not audited with the agent identity: %d %v", invoked, err)
	}
	var startAudit int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND user_id = $2 AND action = 'run.started' AND target_id = $3
		  AND metadata->'actor'->>'mode' = 'agent'`, tenant.org, actorID, runID).Scan(&startAudit); err != nil || startAudit != 1 {
		t.Fatalf("run.started not attributed to the agent: %d %v", startAudit, err)
	}

	limited := issueAgentClient(t, pool, tenant, agentclient.IssueInput{RateLimitPerMinute: 2})
	limitedSession := agentSession(t, pool, eng, limited.Token)
	for range 2 {
		if res, _ := callTool(t, limitedSession, "agent.info", map[string]any{}); res.IsError {
			t.Fatalf("call within the limit refused: %q", resultText(res))
		}
	}
	if res, _ := callTool(t, limitedSession, "agent.info", map[string]any{}); !res.IsError || !strings.Contains(resultText(res), "Rate limit exceeded for mcp.agent") {
		t.Fatalf("per-client rate limit not applied: %q", resultText(res))
	}
}
