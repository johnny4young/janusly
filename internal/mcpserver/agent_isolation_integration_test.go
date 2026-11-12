//go:build integration

package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
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
	draftID, qualificationID        string
	requestID                       string
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
	tenant.draftID, tenant.qualificationID, tenant.requestID = "draft_"+uuid.NewString(), "qual_"+uuid.NewString(), "pub_"+uuid.NewString()
	exec(`INSERT INTO workflow_drafts (id, org_id, workflow_id, document, digest, created_by)
		VALUES ($1, $2, $3, '{"id":"x","nodes":[],"edges":[]}', repeat('a', 64), $4)`, tenant.draftID, tenant.org, tenant.workflowID, tenant.creator)
	exec(`INSERT INTO draft_qualifications (id, org_id, draft_id, digest, status, checks, created_by, completed_at)
		VALUES ($1, $2, $3, repeat('a', 64), 'passed', '[]', $4, now())`, tenant.qualificationID, tenant.org, tenant.draftID, tenant.creator)
	exec(`INSERT INTO publish_requests (id, org_id, workflow_id, draft_id, qualification_id, reasons, requested_by, on_behalf_of, drafted_by, expires_at)
		VALUES ($1, $2, $3, $4, $5, '{writes}', 'agent:seed', $6, 'agent:seed', now() + interval '1 day')`,
		tenant.requestID, tenant.org, tenant.workflowID, tenant.draftID, tenant.qualificationID, tenant.creator)
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
	issued := issueAgentClient(t, pool, home, agentclient.IssueInput{Capabilities: []string{"read", "operate", "propose", "test", "publish"}})
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
		"workflows.pause":      byID(map[string]any{"workflowId": foreign.workflowID}, map[string]any{"workflowId": missing}),
		"workflows.resume":     byID(map[string]any{"workflowId": foreign.workflowID}, map[string]any{"workflowId": missing}),
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
		"drafts.save": byID(
			map[string]any{"workflowId": foreign.workflowID, "workflow": map[string]any{"name": "x", "nodes": []any{}, "edges": []any{}}},
			map[string]any{"workflowId": missing, "workflow": map[string]any{"name": "x", "nodes": []any{}, "edges": []any{}}}),
		"drafts.get":         byID(map[string]any{"draftId": foreign.draftID}, map[string]any{"draftId": missing}),
		"workflows.test":     byID(map[string]any{"draftId": foreign.draftID}, map[string]any{"draftId": missing}),
		"workflows.qualify":  byID(map[string]any{"draftId": foreign.draftID}, map[string]any{"draftId": missing}),
		"qualifications.get": byID(map[string]any{"qualificationId": foreign.qualificationID}, map[string]any{"qualificationId": missing}),
		"workflows.publish": byID(
			map[string]any{"draftId": foreign.draftID, "qualificationId": foreign.qualificationID},
			map[string]any{"draftId": missing, "qualificationId": missing}),
		"publish.status": byID(map[string]any{"publishRequestId": foreign.requestID}, map[string]any{"publishRequestId": missing}),
		"recovery.cases.apply": byID(
			map[string]any{"caseId": foreign.caseID, "expectedRevision": 1, "candidateArtifactId": "candidate", "validationArtifactId": "validation"},
			map[string]any{"caseId": missing, "expectedRevision": 1, "candidateArtifactId": "candidate", "validationArtifactId": "validation"}),
	}
	// Tools without a resource id are checked by what their results leak.
	noForeignInput := map[string]bool{
		"agent.info": true, "catalog.describe": true, "workflows.validate": true, "operations.brief": true,
		"workflows.list": true, "runs.list": true, "dlq.list": true, "drafts.list": true, "credentials.request": true,
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
		for _, id := range []string{foreign.org, foreign.workflowID, foreign.otherWorkflowID, foreign.runID, foreign.otherRunID,
			foreign.deadLetterID, foreign.caseID, foreign.draftID, foreign.qualificationID, foreign.requestID} {
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
	leaks("drafts.list", map[string]any{"limit": 100})
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

// A workflow id another organization owns, even listed in a scope, stays
// unreachable, and a run that names it never shows that organization's name.
func TestAgentClientScopeIgnoresForeignWorkflowIDs(t *testing.T) {
	pool, eng := agentTestPool(t)
	home := seedAgentTenant(t, pool, eng, "scopehome")
	foreign := seedAgentTenant(t, pool, eng, "scopeforeign")
	planted := "run-" + uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO runs (id, org_id, workflow_version_id, workflow_id, status, input_json)
		VALUES ($1, $2, 'adhoc', $3, 'succeeded', '{}')`, planted, home.org, foreign.workflowID); err != nil {
		t.Fatal(err)
	}
	issued := issueAgentClient(t, pool, home, agentclient.IssueInput{ScopeWorkflowIDs: []string{foreign.workflowID, home.workflowID}})
	session := agentSession(t, pool, eng, issued.Token)
	res, _ := callTool(t, session, "workflows.get", map[string]any{"workflowId": foreign.workflowID})
	missing, _ := callTool(t, session, "workflows.get", map[string]any{"workflowId": "missing-" + uuid.NewString()})
	if !res.IsError || resultText(res) != resultText(missing) {
		t.Fatalf("foreign id in scope answered differently: %q", resultText(res))
	}
	_, runs := callTool(t, session, "runs.list", map[string]any{"limit": 100})
	raw, _ := json.Marshal(runs)
	if strings.Contains(string(raw), planted) || strings.Contains(string(raw), "scopeforeign") {
		t.Fatalf("runs.list exposed a foreign workflow: %s", raw)
	}
	if !strings.Contains(string(raw), home.runID) {
		t.Fatalf("runs.list lost the in-scope run: %s", raw)
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
	adhoc := map[string]any{"id": tenant.workflowID, "name": "unsaved", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "only", "type": "noop", "config": map[string]any{}}}, "edges": []any{}}
	if res, _ := callTool(t, session, "runs.start", map[string]any{"workflow": adhoc}); !res.IsError ||
		!strings.Contains(resultText(res), "cannot run an unsaved document") {
		t.Fatalf("an agent ran an unsaved document in production: %q", resultText(res))
	}

	pinned, pinnedPayload := callTool(t, session, "runs.start", map[string]any{"workflowId": tenant.workflowID, "workflowVersionId": tenant.versionID})
	if pinned.IsError {
		t.Fatalf("starting by workflowId with its latest version refused: %q", resultText(pinned))
	}
	var pinnedVersion string
	if err := pool.QueryRow(t.Context(), `SELECT workflow_version_id FROM runs WHERE id = $1`, pinnedPayload["runId"]).Scan(&pinnedVersion); err != nil || pinnedVersion != tenant.versionID {
		t.Fatalf("pinned start ran %q, want %q: %v", pinnedVersion, tenant.versionID, err)
	}
	if stale, _ := callTool(t, session, "runs.start", map[string]any{"workflowId": tenant.workflowID, "workflowVersionId": "not-the-latest"}); !stale.IsError ||
		!strings.Contains(resultText(stale), "not this workflow's latest version") {
		t.Fatalf("a version that is not the latest ran by workflowId: %q", resultText(stale))
	}
	started, payload := callTool(t, session, "runs.start", map[string]any{"workflowId": tenant.workflowID})
	if started.IsError {
		t.Fatalf("in-scope start refused: %q", resultText(started))
	}
	runID, _ := payload["runId"].(string)
	actorID := "agent:" + issued.Client.ID
	var createdBy string
	if err := pool.QueryRow(t.Context(), `SELECT created_by FROM runs WHERE id = $1`, runID).Scan(&createdBy); err != nil || createdBy != actorID {
		t.Fatalf("run attribution: created_by=%q %v", createdBy, err)
	}
	// The creator may not approve writes their agent caused, by start or by redrive.
	if _, err := pool.Exec(t.Context(), `INSERT INTO run_actors (run_id, node_id, role, actor) VALUES ($1, 'only', 'redrive', $2)`,
		tenant.otherRunID, actorID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{runID, tenant.otherRunID} {
		requesters, err := store.New(pool).ListToolApprovalRequesters(t.Context(), store.ListToolApprovalRequestersParams{
			RunID: id, NodeID: "only", MaxDepth: 10,
		})
		if err != nil || !slices.Contains(requesters, tenant.creator) || !slices.Contains(requesters, actorID) {
			t.Fatalf("requesters of %s = %v (%v); want the agent and its creator", id, requesters, err)
		}
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

	// Idempotency keys are per client: a key someone else used never replays their run.
	if _, err := pool.Exec(t.Context(), `INSERT INTO run_start_idempotency (org_id, idempotency_key, run_id) VALUES ($1, 'shared-key', $2)`,
		tenant.org, tenant.otherRunID); err != nil {
		t.Fatal(err)
	}
	first, firstPayload := callTool(t, session, "runs.start", map[string]any{"workflowId": tenant.workflowID, "idempotencyKey": "shared-key"})
	again, againPayload := callTool(t, session, "runs.start", map[string]any{"workflowId": tenant.workflowID, "idempotencyKey": "shared-key"})
	if first.IsError || again.IsError || firstPayload["runId"] == tenant.otherRunID || firstPayload["replayed"] == true ||
		againPayload["runId"] != firstPayload["runId"] || againPayload["replayed"] != true {
		t.Fatalf("idempotency across actors: first %v, again %v", firstPayload, againPayload)
	}

	// The catalog version does not move when an out-of-scope workflow changes.
	// A key claimed under the agent's namespace by someone else never replays to it.
	if _, err := pool.Exec(t.Context(), `INSERT INTO run_start_idempotency (org_id, idempotency_key, run_id) VALUES ($1, $2, $3)`,
		tenant.org, actorID+":squatted", tenant.otherRunID); err != nil {
		t.Fatal(err)
	}
	if res, payload := callTool(t, session, "runs.start", map[string]any{"workflowId": tenant.workflowID, "idempotencyKey": "squatted"}); !res.IsError ||
		strings.Contains(resultText(res), tenant.otherRunID) {
		t.Fatalf("a squatted key replayed someone else's run: %v %q", payload, resultText(res))
	}

	_, before := callTool(t, session, "catalog.describe", map[string]any{})
	if _, err := eng.SaveWorkflowVersion(t.Context(), engine.SaveWorkflowVersionInput{
		OrgID: tenant.org, UserID: tenant.creator, NewID: uuid.NewString,
		Workflow: &domain.Workflow{ID: tenant.org + "-later", Name: "later", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "only", Type: "noop", Config: map[string]any{}}}, Edges: []domain.Edge{}},
	}); err != nil {
		t.Fatal(err)
	}
	_, after := callTool(t, session, "catalog.describe", map[string]any{})
	if before["catalogVersion"] == nil || before["catalogVersion"] != after["catalogVersion"] {
		t.Fatalf("catalogVersion reveals out-of-scope changes: %v -> %v", before["catalogVersion"], after["catalogVersion"])
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

// An operating agent pauses and resumes a workflow in its scope without
// trashing it; a read-only agent cannot, and nothing outside its scope moves.
func TestAgentClientPausesAndResumesWithinScope(t *testing.T) {
	pool, eng := agentTestPool(t)
	tenant := seedAgentTenant(t, pool, eng, "pause")
	status := func(workflowID string) string {
		t.Helper()
		var value string
		if err := pool.QueryRow(t.Context(), `SELECT status FROM workflows WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
			tenant.org, workflowID).Scan(&value); err != nil {
			t.Fatalf("status %s: %v", workflowID, err)
		}
		return value
	}

	reader := agentSession(t, pool, eng, issueAgentClient(t, pool, tenant, agentclient.IssueInput{Capabilities: []string{"read"}}).Token)
	if res, _ := callTool(t, reader, "workflows.pause", map[string]any{"workflowId": tenant.workflowID}); !res.IsError {
		t.Fatal("a read-only agent paused a workflow")
	}

	operator := issueAgentClient(t, pool, tenant, agentclient.IssueInput{Capabilities: []string{"operate"}, ScopeTags: []string{"billing"}})
	session := agentSession(t, pool, eng, operator.Token)
	if res, _ := callTool(t, session, "workflows.pause", map[string]any{"workflowId": tenant.otherWorkflowID}); !res.IsError {
		t.Fatal("an agent paused a workflow outside its scope")
	}
	res, paused := callTool(t, session, "workflows.pause", map[string]any{"workflowId": tenant.workflowID, "reason": "nightly maintenance"})
	if res.IsError || paused["status"] != "paused_manual" || paused["changed"] != true {
		t.Fatalf("pause: %q %v", resultText(res), paused)
	}
	if got := status(tenant.workflowID); got != "paused_manual" {
		t.Fatalf("after pause: %s", got)
	}
	res, resumed := callTool(t, session, "workflows.resume", map[string]any{"workflowId": tenant.workflowID})
	if res.IsError || resumed["status"] != "active" || resumed["changed"] != true {
		t.Fatalf("resume: %q %v", resultText(res), resumed)
	}
	if got, other := status(tenant.workflowID), status(tenant.otherWorkflowID); got != "active" || other != "active" {
		t.Fatalf("after resume: %s, other %s", got, other)
	}
	var actions string
	if err := pool.QueryRow(t.Context(), `SELECT string_agg(action, ',' ORDER BY created_at, id) FROM audit_logs
		WHERE org_id = $1 AND target_id = $2 AND user_id = $3`, tenant.org, tenant.workflowID, "agent:"+operator.Client.ID).Scan(&actions); err != nil {
		t.Fatal(err)
	}
	if actions != "workflow.paused,workflow.resumed" {
		t.Fatalf("agent audit trail: %q", actions)
	}
}
