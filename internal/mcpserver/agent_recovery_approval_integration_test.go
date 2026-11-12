//go:build integration

package mcpserver

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
)

// The person who created an agent client cannot approve a fix that agent
// prepared, over stdio or remote MCP; another member can. A fix the stdio
// operator prepared has no agent creator to exclude.
func TestAgentCreatorCannotApproveTheAgentsRecovery(t *testing.T) {
	pool, eng := agentTestPool(t)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	workersDone := make(chan struct{})
	go func() {
		defer close(workersDone)
		_ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, dispatcher.Execute, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { stopWorkers(); <-workersDone })

	tenant := seedAgentTenant(t, pool, eng, "recovery-approval")
	peer := "peer-" + uuid.NewString()[:8]
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor')`,
		uuid.NewString(), tenant.org, peer); err != nil {
		t.Fatal(err)
	}
	wf := mcpSemanticWorkflow(tenant.org + "-semantic")
	saved, err := eng.SaveWorkflowVersion(t.Context(), engine.SaveWorkflowVersionInput{
		OrgID: tenant.org, UserID: tenant.creator, Workflow: wf, NewID: uuid.NewString,
	})
	if err != nil {
		t.Fatal(err)
	}
	issued := issueAgentClient(t, pool, tenant, agentclient.IssueInput{Capabilities: []string{"operate"}})
	remote := httptest.NewServer(NewHTTPHandler(Deps{Engine: eng, Pool: pool, NewID: uuid.NewString}, HTTPOptions{}))
	t.Cleanup(remote.Close)
	remoteAgent, err := remoteSession(t, remote.URL+"/mcp", issued.Token)
	if err != nil {
		t.Fatalf("connect remote: %v", err)
	}
	t.Cleanup(func() { _ = remoteAgent.Close() })

	type prepared struct {
		caseID, candidateID, validationID string
		revision                          int64
	}
	// prepare drives a fresh semantic case to awaiting approval through MCP.
	prepare := func(session *mcp.ClientSession) prepared {
		t.Helper()
		runID, err := eng.StartRun(t.Context(), engine.StartInput{
			OrgID: tenant.org, Workflow: wf, WorkflowVersionID: saved.VersionID,
			Input: map[string]any{"total": "900"}, CreatedBy: tenant.creator,
		})
		if err != nil {
			t.Fatal(err)
		}
		waitMCPRunStatus(t, pool, runID, "waiting")
		var p prepared
		if err := pool.QueryRow(t.Context(), `SELECT id, revision FROM recovery_cases WHERE org_id = $1 AND run_id = $2`,
			tenant.org, runID).Scan(&p.caseID, &p.revision); err != nil {
			t.Fatal(err)
		}
		res, diagnosed := callTool(t, session, "recovery.cases.diagnose", map[string]any{
			"caseId": p.caseID, "expectedRevision": p.revision,
			"manualReplacement": map[string]any{"output": map[string]any{"total": "10"}, "reason": "restore the contract total"},
		})
		if res.IsError {
			t.Fatalf("diagnose: %s", resultText(res))
		}
		for _, item := range diagnosed["candidates"].([]any) {
			candidate := item.(map[string]any)
			if candidate["candidate"].(map[string]any)["kind"] == "replace_output" {
				p.candidateID = candidate["id"].(string)
			}
		}
		res, validated := callTool(t, session, "recovery.cases.validate", map[string]any{
			"caseId": p.caseID, "expectedRevision": int64(diagnosed["case"].(map[string]any)["revision"].(float64)),
			"candidateArtifactId": p.candidateID,
		})
		if res.IsError || validated["passed"] != true {
			t.Fatalf("validate: %s", resultText(res))
		}
		p.validationID = validated["validation"].(map[string]any)["id"].(string)
		p.revision = int64(validated["case"].(map[string]any)["revision"].(float64))
		return p
	}
	approve := func(p prepared, user string, mode auth.Mode) error {
		t.Helper()
		_, err := eng.ApproveRecoveryCandidate(t.Context(), engine.ApproveRecoveryCandidateInput{
			Auth:   &auth.Context{OrgID: tenant.org, UserID: user, Mode: mode, Source: auth.SourceWeb},
			CaseID: p.caseID, ExpectedRevision: p.revision, CandidateArtifactID: p.candidateID, ValidationArtifactID: p.validationID,
		})
		return err
	}

	stdioAgent := agentSession(t, pool, eng, issued.Token)
	for label, session := range map[string]*mcp.ClientSession{"stdio agent": stdioAgent, "remote agent": remoteAgent} {
		p := prepare(session)
		if err := approve(p, tenant.creator, auth.ModeSupabase); !errors.Is(err, engine.ErrRecoverySelfApproval) {
			t.Fatalf("%s: the agent's creator approved its fix: %v", label, err)
		}
		if err := approve(p, peer, auth.ModeSupabase); err != nil {
			t.Fatalf("%s: another member could not approve: %v", label, err)
		}
		res, applied := callTool(t, session, "recovery.cases.apply", map[string]any{
			"caseId": p.caseID, "expectedRevision": p.revision, "candidateArtifactId": p.candidateID, "validationArtifactId": p.validationID,
		})
		if res.IsError || applied["resumed"] != true {
			t.Fatalf("%s: apply with another member's approval: %s", label, resultText(res))
		}
	}

	operator := operatorSession(t, pool, eng, tenant.org)
	p := prepare(operator)
	if err := approve(p, "mcp", auth.ModeServiceToken); !errors.Is(err, engine.ErrRecoveryHumanApprovalRequired) {
		t.Fatalf("the stdio operator approved its own fix: %v", err)
	}
	if err := approve(p, tenant.creator, auth.ModeSupabase); err != nil {
		t.Fatalf("a person could not approve the stdio operator's fix: %v", err)
	}
}
