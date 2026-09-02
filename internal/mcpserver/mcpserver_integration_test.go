//go:build integration

package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/packs"
)

// An SDK client drives the failure→redrive cycle through the in-process
// server — the same loop an agent would run from Claude.

func anthropicMCPReply(text string) string {
	payload, _ := json.Marshal(map[string]any{
		"id": "msg_mcp", "type": "message", "role": "assistant",
		"model":       "claude-haiku-4-5-20251001",
		"content":     []map[string]any{{"type": "text", "text": text}},
		"stop_reason": "end_turn",
		"usage":       map[string]any{"input_tokens": 10, "output_tokens": 5},
	})
	return string(payload)
}

func newMCPSession(t *testing.T) (*mcp.ClientSession, string) {
	return newMCPSessionWithPermissions(t, fullMCPTestPermissions())
}

func newMCPSessionWithPermissions(t *testing.T, permissions map[string]bool) (*mcp.ClientSession, string) {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	eng := engine.New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, dispatcher.Execute,
			slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { stopWorkers(); <-done })

	org := fmt.Sprintf("mcp-org-%d", time.Now().UnixNano())
	// Write tools run under the two-flag consent; the harness models a
	// fully consented environment. The denial ladder has its own test.
	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "true")
	if _, err := pool.Exec(ctx,
		`INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		 VALUES ($1, $2, 'mcp.writeConsent', 'true', 'mcp', 'test consent', 'boolean')`,
		org+"-consent", org); err != nil {
		t.Fatalf("seed consent: %v", err)
	}
	server := NewServer(Deps{
		Engine: eng, Pool: pool, OrgID: org, UserID: "mcp-test", NewID: uuid.NewString,
		Permissions: permissions,
	})

	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		_ = server.Run(context.Background(), serverTransport)
	}()

	client := mcp.NewClient(&mcp.Implementation{Name: "consistency-client", Version: "0.0.1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close(); <-serverDone })
	return session, org
}

func mcpSemanticWorkflow(id string) *domain.Workflow {
	contract := &domain.RecoveryContract{Version: "2"}
	contract.Failure.Technical.TerminalNodeFailure = true
	contract.Failure.Semantic.Mode = "deterministic"
	contract.Failure.Semantic.Detectors = []domain.RecoverySemanticDetector{{
		ID: "det-total", SourceNodeID: "calc", Kind: "expression",
		PassWhen: "context.calc.output.total === '10'", Action: "quarantine",
		Message: "total out of bounds",
	}}
	contract.Failure.Semantic.EvaluationFixtures = []domain.RecoverySemanticFixture{
		{ID: "fx-pass", SourceNodeID: "calc", Output: map[string]any{"total": "10"}, Expected: "pass"},
		{ID: "fx-violation", SourceNodeID: "calc", Output: map[string]any{"total": "900"}, Expected: "violation"},
	}
	contract.Evidence.Required = []string{"failure_snapshot", "audit_trail", "terminal_outcome"}
	contract.Effects = []domain.RecoveryEffect{}
	contract.Repairs.Allowed = []string{"retry"}
	contract.Validation.MinimumEvidenceLevel = "static"
	contract.Approval.ProductionMutation = "required"
	contract.Approval.Permission = "recovery.write"
	contract.AutonomyLevel = 3
	contract.Verification.Kind = "generation_bound_terminal_success"
	contract.Recurrence.WindowDays = 7
	return &domain.Workflow{
		ID: id, Name: "MCP semantic", DSLVersion: "1.0",
		Recovery: &domain.WorkflowRecovery{Contract: contract},
		Nodes: []domain.Node{
			{ID: "calc", Type: "transform", Config: map[string]any{"mapping": map[string]any{"total": "{{context.input.total}}"}}},
			{ID: "after", Type: "noop", Config: map[string]any{}},
		},
		Edges: []domain.Edge{{From: "calc", To: "after"}},
	}
}

func waitMCPRunStatus(t *testing.T, pool *pgxpool.Pool, runID, want string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var status string
		if err := pool.QueryRow(t.Context(), `SELECT status FROM runs WHERE id=$1`, runID).Scan(&status); err == nil && status == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("run %s did not reach %s", runID, want)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestMcpPermissionCeilingKeepsViewerReadOnlyAndTenantScoped(t *testing.T) {
	permissions, err := ParsePermissionCeiling("")
	if err != nil {
		t.Fatal(err)
	}
	session, orgID := newMCPSessionWithPermissions(t, permissions)
	pool := poolForTest(t)
	wf := mcpSemanticWorkflow("viewer-workflow")
	wire, _ := json.Marshal(map[string]any{"workflow": wf, "input": map[string]any{"total": "900"}})
	caseID := "viewer-case-" + uuid.NewString()
	runID := "viewer-run-" + uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO runs (id,org_id,workflow_version_id,status,input_json)
		VALUES ($1,$2,'viewer-version','waiting',$3)`, runID, orgID, wire); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO recovery_cases
		(id,org_id,run_id,workflow_id,workflow_version_id,source,detector_id,source_node_id,detector_kind,action,message,details_json,state,revision)
		VALUES ($1,$2,$3,'viewer-workflow','viewer-version','semantic_violation','det-total','calc','expression','quarantine',$4,$5,'contained',1)`,
		caseID, orgID, runID, "malicious sk-abcdefghijklmnopqrstuv", json.RawMessage(`{"private":"must-not-return"}`)); err != nil {
		t.Fatal(err)
	}

	inspect, payload := callTool(t, session, "recovery.cases.inspect", map[string]any{"caseId": caseID})
	if inspect.IsError || payload["case"].(map[string]any)["id"] != caseID {
		t.Fatalf("viewer inspect failed: %+v", payload)
	}
	raw, _ := json.Marshal(payload)
	if strings.Contains(string(raw), "must-not-return") || strings.Contains(string(raw), "sk-abcdefghijklmnopqrstuv") {
		t.Fatalf("inspect leaked case evidence: %s", raw)
	}
	for name, args := range map[string]map[string]any{
		"runs.start":              {"workflow": map[string]any{}},
		"workflows.propose":       {"prompt": "Create a workflow"},
		"recovery.cases.diagnose": {"caseId": caseID, "expectedRevision": 1},
		"recovery.cases.validate": {"caseId": caseID, "expectedRevision": 1, "candidateArtifactId": "candidate"},
		"recovery.cases.apply":    {"caseId": caseID, "expectedRevision": 1, "candidateArtifactId": "candidate", "validationArtifactId": "validation"},
	} {
		res, _ := callTool(t, session, name, args)
		if !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "lacks permission") {
			t.Fatalf("viewer mutation %s was not permission denied: %+v", name, res)
		}
	}

	foreignCaseID := "foreign-case-" + uuid.NewString()
	foreignRunID := "foreign-run-" + uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO runs (id,org_id,workflow_version_id,status,input_json)
		VALUES ($1,$2,'foreign-version','waiting',$3)`, foreignRunID, orgID+"-foreign", wire); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO recovery_cases
		(id,org_id,run_id,workflow_version_id,source,detector_id,source_node_id,detector_kind,action,message,state,revision)
		VALUES ($1,$2,$3,'foreign-version','semantic_violation','det-total','calc','expression','quarantine','foreign','contained',1)`,
		foreignCaseID, orgID+"-foreign", foreignRunID); err != nil {
		t.Fatal(err)
	}
	foreign, _ := callTool(t, session, "recovery.cases.inspect", map[string]any{"caseId": foreignCaseID})
	if !foreign.IsError || foreign.Content[0].(*mcp.TextContent).Text != "recovery case not found" {
		t.Fatal("foreign recovery case must be invisible")
	}
}

func TestMcpGovernedSemanticRecoveryRequiresIndependentApproval(t *testing.T) {
	session, orgID := newMCPSession(t)
	pool := poolForTest(t)
	eng := engine.New(pool)
	wf := mcpSemanticWorkflow("mcp-governed-" + uuid.NewString())
	saved, err := eng.SaveWorkflowVersion(t.Context(), engine.SaveWorkflowVersionInput{
		OrgID: orgID, UserID: "mcp-test", Workflow: wf, NewID: uuid.NewString,
	})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := eng.StartRun(t.Context(), engine.StartInput{
		OrgID: orgID, Workflow: wf, WorkflowVersionID: saved.VersionID,
		Input: map[string]any{"total": "900"}, CreatedBy: "mcp-test",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitMCPRunStatus(t, pool, runID, "waiting")
	var caseID, state, caseWorkflowID, caseWorkflowVersionID string
	var revision int64
	if err := pool.QueryRow(t.Context(), `SELECT id,state,revision,workflow_id,workflow_version_id
		FROM recovery_cases WHERE org_id=$1 AND run_id=$2`, orgID, runID).
		Scan(&caseID, &state, &revision, &caseWorkflowID, &caseWorkflowVersionID); err != nil {
		t.Fatal(err)
	}
	if state != "contained" {
		t.Fatalf("case state = %s", state)
	}
	if caseWorkflowID != wf.ID || caseWorkflowVersionID != saved.VersionID {
		t.Fatalf("saved recovery target mismatch: workflow=%q version=%q want=%q/%q",
			caseWorkflowID, caseWorkflowVersionID, wf.ID, saved.VersionID)
	}
	briefResult, initialBrief := callTool(t, session, "operations.brief", map[string]any{})
	initialActions, _ := initialBrief["actions"].([]any)
	if briefResult.IsError || len(initialActions) != 1 {
		t.Fatalf("initial operator brief must surface the one semantic case: error=%v payload=%+v", briefResult.IsError, initialBrief)
	}
	initialPriority := initialActions[0].(map[string]any)
	initialTarget, _ := initialPriority["target"].(map[string]any)
	initialWire, _ := json.Marshal(initialPriority)
	if initialPriority["priority"] != float64(1) || initialPriority["kind"] != "semantic_case" ||
		initialTarget["id"] != caseID || !strings.Contains(string(initialWire), "recovery.cases.diagnose") {
		t.Fatalf("operator brief did not expose the exact bounded next action: %s", initialWire)
	}

	diagnose, diagnosed := callTool(t, session, "recovery.cases.diagnose", map[string]any{
		"caseId": caseID, "expectedRevision": revision,
		"manualReplacement": map[string]any{
			"output": map[string]any{"total": "10"},
			"reason": "restore the contractually valid total sk-abcdefghijklmnopqrstuv",
		},
	})
	if diagnose.IsError {
		t.Fatalf("diagnose: %s", diagnose.Content[0].(*mcp.TextContent).Text)
	}
	candidates := diagnosed["candidates"].([]any)
	if len(candidates) < 1 || len(candidates) > 3 {
		t.Fatalf("candidate count must be bounded: %+v", diagnosed)
	}
	var candidateID, repairCandidateID string
	for _, item := range candidates {
		candidate := item.(map[string]any)
		projection, _ := candidate["candidate"].(map[string]any)
		if projection["kind"] == "replace_output" {
			candidateID, _ = candidate["id"].(string)
		}
		if projection["kind"] == "repair_workflow" {
			repairCandidateID, _ = candidate["id"].(string)
		}
	}
	if candidateID == "" || repairCandidateID == "" {
		t.Fatalf("replacement candidate missing: %+v", candidates)
	}
	rawDiagnosed, _ := json.Marshal(diagnosed)
	for _, forbidden := range []string{"contractually valid", "sk-abcdefghijklmnopqrstuv", `"total":"10"`} {
		if strings.Contains(string(rawDiagnosed), forbidden) {
			t.Fatalf("diagnose leaked candidate evidence %q: %s", forbidden, rawDiagnosed)
		}
	}
	revision = int64(diagnosed["case"].(map[string]any)["revision"].(float64))
	followUpValidation, followUp := callTool(t, session, "recovery.cases.validate", map[string]any{
		"caseId": caseID, "expectedRevision": revision, "candidateArtifactId": repairCandidateID,
	})
	if followUpValidation.IsError || followUp["passed"] != false ||
		followUp["case"].(map[string]any)["state"] != "candidates_ready" {
		t.Fatalf("manual follow-up must validate visibly but remain unappliable: error=%v payload=%+v", followUpValidation.IsError, followUp)
	}
	revision = int64(followUp["case"].(map[string]any)["revision"].(float64))

	validate, validated := callTool(t, session, "recovery.cases.validate", map[string]any{
		"caseId": caseID, "expectedRevision": revision, "candidateArtifactId": candidateID,
	})
	if validate.IsError || validated["passed"] != true {
		t.Fatalf("validate: error=%v payload=%+v", validate.IsError, validated)
	}
	validationID := validated["validation"].(map[string]any)["id"].(string)
	revision = int64(validated["case"].(map[string]any)["revision"].(float64))
	approvalBriefResult, approvalBrief := callTool(t, session, "operations.brief", map[string]any{})
	approvalActions, _ := approvalBrief["actions"].([]any)
	if approvalBriefResult.IsError || len(approvalActions) != 1 {
		t.Fatalf("approval operator brief: error=%v payload=%+v", approvalBriefResult.IsError, approvalBrief)
	}
	approvalPriority := approvalActions[0].(map[string]any)
	approvalTarget, _ := approvalPriority["target"].(map[string]any)
	approvalWire, _ := json.Marshal(approvalPriority)
	if approvalPriority["priority"] != float64(1) || approvalPriority["kind"] != "recovery_approval" ||
		approvalTarget["id"] != caseID || !strings.Contains(string(approvalWire), "recovery.cases.apply") {
		t.Fatalf("operator brief did not rerank the independent approval blocker: %s", approvalWire)
	}
	if strings.Contains(string(approvalWire), "recovery.cases.approve") {
		t.Fatalf("MCP operator brief must not advertise human approval authority: %s", approvalWire)
	}

	withoutApproval, _ := callTool(t, session, "recovery.cases.apply", map[string]any{
		"caseId": caseID, "expectedRevision": revision,
		"candidateArtifactId": candidateID, "validationArtifactId": validationID,
	})
	if !withoutApproval.IsError {
		t.Fatal("MCP apply must fail without an independent human grant")
	}

	human := &auth.Context{OrgID: orgID, UserID: "human-approver", Mode: auth.ModeDevHeaders, Source: auth.SourceWeb}
	grant, err := eng.ApproveRecoveryCandidate(t.Context(), engine.ApproveRecoveryCandidateInput{
		Auth: human, CaseID: caseID, ExpectedRevision: revision,
		CandidateArtifactID: candidateID, ValidationArtifactID: validationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	inspect, inspected := callTool(t, session, "recovery.cases.inspect", map[string]any{"caseId": caseID})
	if inspect.IsError {
		t.Fatal("inspect after approval failed")
	}
	rawInspect, _ := json.Marshal(inspected)
	if strings.Contains(string(rawInspect), grant.ID) || strings.Contains(string(rawInspect), "human-approver") {
		t.Fatalf("inspect exposed active grant: %s", rawInspect)
	}

	apply, applied := callTool(t, session, "recovery.cases.apply", map[string]any{
		"caseId": caseID, "expectedRevision": revision,
		"candidateArtifactId": candidateID, "validationArtifactId": validationID,
	})
	if apply.IsError || applied["resumed"] != true || applied["decision"] != "replace" {
		t.Fatalf("approved apply failed: error=%v payload=%+v", apply.IsError, applied)
	}
	waitMCPRunStatus(t, pool, runID, "succeeded")

	reused, _ := callTool(t, session, "recovery.cases.apply", map[string]any{
		"caseId": caseID, "expectedRevision": revision,
		"candidateArtifactId": candidateID, "validationArtifactId": validationID,
	})
	if !reused.IsError {
		t.Fatal("one-use approval/candidate apply must not be reusable")
	}
	var agentArtifacts, incorrectlyHumanArtifacts int
	if err := pool.QueryRow(t.Context(), `SELECT
		count(*) FILTER (WHERE actor_kind='agent'),
		count(*) FILTER (WHERE actor_kind='user')
		FROM recovery_case_artifacts
		WHERE org_id=$1 AND case_id=$2`, orgID, caseID).
		Scan(&agentArtifacts, &incorrectlyHumanArtifacts); err != nil {
		t.Fatal(err)
	}
	if agentArtifacts < 4 || incorrectlyHumanArtifacts != 0 {
		t.Fatalf("MCP recovery provenance must remain agent-authored: agent=%d user=%d",
			agentArtifacts, incorrectlyHumanArtifacts)
	}
	var invoked int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id=$1 AND action='mcp.tool.invoked' AND target_id LIKE 'recovery.cases.%'`, orgID).Scan(&invoked); err != nil {
		t.Fatal(err)
	}
	if invoked < 6 {
		t.Fatalf("every recovery MCP invocation must be audited, got %d", invoked)
	}
}

func TestMcpRecoveryDiagnosisAIRespectsExplicitPermissionCeiling(t *testing.T) {
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("content-type", "application/json")
		_, _ = fmt.Fprint(w, anthropicMCPReply(`{"summary":"The bounded evidence points to a contract mismatch.","hypotheses":[{"id":"contract_mismatch","cause":"The deterministic detector rejected the source outcome.","confidence":0.8,"evidence":["The detector recorded a semantic violation."],"counterEvidence":["No retained comparable case confirms recurrence."]}]}`))
	}))
	t.Cleanup(provider.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", provider.URL)

	seed := func(orgID, prefix string) string {
		t.Helper()
		pool := poolForTest(t)
		runID := prefix + "-run-" + uuid.NewString()
		caseID := prefix + "-case-" + uuid.NewString()
		if _, err := pool.Exec(t.Context(), `INSERT INTO runs
			(id,org_id,workflow_version_id,status,input_json) VALUES ($1,$2,'version','waiting','{}')`, runID, orgID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), `INSERT INTO recovery_cases
			(id,org_id,run_id,workflow_id,workflow_version_id,source,detector_id,source_node_id,detector_kind,action,message,state,revision)
			VALUES ($1,$2,$3,'workflow','version','semantic_violation','detector','source','expression','quarantine','bounded mismatch','contained',1)`,
			caseID, orgID, runID); err != nil {
			t.Fatal(err)
		}
		return caseID
	}

	aiSession, aiOrg := newMCPSession(t)
	aiCase := seed(aiOrg, "ai")
	oversized, _ := callTool(t, aiSession, "recovery.cases.diagnose", map[string]any{
		"caseId": aiCase, "expectedRevision": 1,
		"manualReplacement": map[string]any{
			"output": strings.Repeat("x", 70_000), "reason": "bounded preflight",
		},
	})
	if !oversized.IsError || calls.Load() != 0 {
		t.Fatalf("oversized candidate must fail before AI or mutation: error=%v calls=%d", oversized.IsError, calls.Load())
	}
	var preflightState string
	var preflightRevision int64
	var preflightArtifacts int
	if err := poolForTest(t).QueryRow(t.Context(), `SELECT state,revision,
		(SELECT count(*) FROM recovery_case_artifacts WHERE org_id=$1 AND case_id=$2)
		FROM recovery_cases WHERE org_id=$1 AND id=$2`, aiOrg, aiCase).
		Scan(&preflightState, &preflightRevision, &preflightArtifacts); err != nil {
		t.Fatal(err)
	}
	if preflightState != "contained" || preflightRevision != 1 || preflightArtifacts != 0 {
		t.Fatalf("failed preflight mutated case: state=%s revision=%d artifacts=%d",
			preflightState, preflightRevision, preflightArtifacts)
	}
	result, payload := callTool(t, aiSession, "recovery.cases.diagnose", map[string]any{
		"caseId": aiCase, "expectedRevision": 1,
	})
	if result.IsError || payload["mode"] != "ai_enriched" || calls.Load() != 1 {
		t.Fatalf("MCP AI diagnosis: error=%v calls=%d payload=%+v", result.IsError, calls.Load(), payload)
	}
	diagnosis := payload["diagnosis"].(map[string]any)["diagnosis"].(map[string]any)
	if diagnosis["mode"] != "ai_enriched" {
		t.Fatalf("bounded diagnosis projection lost mode: %+v", diagnosis)
	}
	raw, _ := json.Marshal(payload)
	for _, forbidden := range []string{"contract mismatch", "deterministic detector", "bounded mismatch"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("MCP must withhold diagnosis prose %q: %s", forbidden, raw)
		}
	}

	withoutAI := map[string]bool{"recovery.read": true, "recovery.write": true}
	deterministicSession, deterministicOrg := newMCPSessionWithPermissions(t, withoutAI)
	deterministicCase := seed(deterministicOrg, "deterministic")
	before := calls.Load()
	result, payload = callTool(t, deterministicSession, "recovery.cases.diagnose", map[string]any{
		"caseId": deterministicCase, "expectedRevision": 1,
	})
	if result.IsError || payload["mode"] != "deterministic_fallback" || calls.Load() != before {
		t.Fatalf("MCP permission fallback: error=%v calls=%d payload=%+v", result.IsError, calls.Load()-before, payload)
	}
}

func TestMcpWorkflowProposalBindsExactCatalogWithoutReturningDAG(t *testing.T) {
	session, _ := newMCPSession(t)
	res, proposed := callTool(t, session, "workflows.propose", map[string]any{
		"prompt": "Send an incident notification",
		"workflow": map[string]any{
			"id": "invented-proposal", "name": "Invented",
			"nodes": []any{map[string]any{
				"id": "notify", "type": "tool",
				"config": map[string]any{"tool": "invented.send", "apiKey": "must-not-return"},
			}},
			"edges": []any{},
		},
	})
	if res.IsError || proposed["applicable"] != false {
		t.Fatalf("invented proposal should be a safe incomplete result: error=%v %+v", res.IsError, proposed)
	}
	raw, _ := json.Marshal(proposed)
	for _, forbidden := range []string{`"config"`, "must-not-return", `"apiKey"`, `"nodes":[{"config"`} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("proposal returned full DAG/config %q: %s", forbidden, raw)
		}
	}
	if !strings.Contains(string(raw), "exact_tool_not_found") {
		t.Fatalf("missing binding not explicit: %s", raw)
	}
}

func TestMcpPagerDutyFlagshipIsProviderFreeBoundedAndExactlyBound(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	session, orgID := newMCPSession(t)
	pool := poolForTest(t)
	suffix := uuid.NewString()
	apiCredential := "pd-api-" + suffix
	webhookCredential := "pd-hook-" + suffix
	for _, credential := range []struct{ id, name, kind string }{
		{"cred-api-" + suffix, apiCredential, "pagerduty_api_token"},
		{"cred-hook-" + suffix, webhookCredential, "pagerduty_webhook_secret"},
	} {
		if _, err := pool.Exec(t.Context(), `INSERT INTO credentials
			(id,org_id,name,kind,secret_ref,created_by) VALUES ($1,$2,$3,$4,$5,'mcp-test')`,
			credential.id, orgID, credential.name, credential.kind, "env://JANUSLY_CRED_MCP_"+strings.ToUpper(strings.ReplaceAll(credential.id, "-", "_"))); err != nil {
			t.Fatal(err)
		}
	}

	prompt := "From 2026-09-01 to 2026-09-07, when PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours using operator@example.com."
	result, proposed := callTool(t, session, "workflows.propose", map[string]any{"prompt": prompt})
	if result.IsError || proposed["applicable"] != true || proposed["mode"] != "deterministic_fallback" {
		t.Fatalf("bounded flagship proposal: error=%v payload=%+v", result.IsError, proposed)
	}
	bindings, _ := proposed["bindings"].(map[string]any)
	workflow, _ := proposed["workflow"].(map[string]any)
	if bindings["complete"] != true || workflow["nodeCount"] != float64(11) || workflow["edgeCount"] != float64(11) {
		t.Fatalf("flagship binding/shape drift: bindings=%+v workflow=%+v", bindings, workflow)
	}
	raw, _ := json.Marshal(proposed)
	if len(raw) > 64_000 {
		t.Fatalf("flagship MCP response is not bounded: %d bytes", len(raw))
	}
	for _, forbidden := range []string{`"config"`, `"input"`, `"edges"`, "env://JANUSLY_CRED_MCP_"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("flagship MCP response exposed DAG/secret reference %q: %s", forbidden, raw)
		}
	}
	for _, expected := range []string{apiCredential, webhookCredential, "pagerduty_incident", "deterministic"} {
		if !strings.Contains(string(raw), expected) {
			t.Fatalf("flagship MCP response omitted bounded evidence %q: %s", expected, raw)
		}
	}

	vague, vaguePayload := callTool(t, session, "workflows.propose", map[string]any{
		"prompt": "Durante una semana, PagerDuty mueve casos a revisando en ciertos rangos y los aplaza por 12 horas.",
	})
	questions, _ := vaguePayload["clarifyingQuestions"].([]any)
	vagueWorkflow, _ := vaguePayload["workflow"].(map[string]any)
	if vague.IsError || vaguePayload["mode"] != "clarification_required" || vaguePayload["applicable"] != false ||
		len(questions) == 0 || len(questions) > 3 || vagueWorkflow["parseable"] != false || vagueWorkflow["nodeCount"] != float64(0) {
		t.Fatalf("vague MCP intent must remain bounded and incomplete: error=%v payload=%+v", vague.IsError, vaguePayload)
	}
	if _, exposed := vagueWorkflow["id"]; exposed {
		t.Fatalf("unresolved MCP intent must not manufacture a workflow identity: %+v", vagueWorkflow)
	}
}

func TestMcpWorkflowSaveUsesCanonicalAtomicEngineOperation(t *testing.T) {
	session, orgID := newMCPSession(t)
	pool := poolForTest(t)
	workflowID := "mcp-atomic-save-" + uuid.NewString()
	document := map[string]any{
		"id": workflowID, "mystery": "strip-me",
		"nodes": []any{map[string]any{
			"id": "hourly", "type": "schedule", "unknown": "strip-me",
			"config": map[string]any{"cronExpression": "0 * * * *", "enabled": true},
		}},
		"edges": []any{},
	}

	const writers = 8
	type saveOutcome struct {
		result *mcp.CallToolResult
		err    error
	}
	outcomes := make(chan saveOutcome, writers)
	var group sync.WaitGroup
	group.Add(writers)
	for range writers {
		go func() {
			defer group.Done()
			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
				Name: "workflows.save", Arguments: map[string]any{"workflow": document},
			})
			outcomes <- saveOutcome{result: result, err: err}
		}()
	}
	group.Wait()
	close(outcomes)

	versions := make(map[int]bool, writers)
	for outcome := range outcomes {
		if outcome.err != nil || outcome.result == nil || outcome.result.IsError {
			t.Fatalf("concurrent MCP save failed: result=%+v err=%v", outcome.result, outcome.err)
		}
		var payload map[string]any
		text := outcome.result.Content[0].(*mcp.TextContent).Text
		if json.Unmarshal([]byte(text), &payload) != nil {
			t.Fatalf("invalid save response: %s", text)
		}
		versions[int(payload["version"].(float64))] = true
	}
	if len(versions) != writers {
		t.Fatalf("MCP saves lost or duplicated versions: %+v", versions)
	}
	for version := 1; version <= writers; version++ {
		if !versions[version] {
			t.Fatalf("MCP save sequence omitted version %d: %+v", version, versions)
		}
	}

	var parentName, versionID string
	var dagJSON []byte
	if err := pool.QueryRow(t.Context(), `
		SELECT w.name, wv.id, wv.dag_json
		FROM workflows w
		JOIN workflow_versions wv ON wv.org_id=w.org_id AND wv.workflow_id=w.id
		WHERE w.org_id=$1 AND w.id=$2
		ORDER BY wv.version DESC LIMIT 1`, orgID, workflowID).
		Scan(&parentName, &versionID, &dagJSON); err != nil {
		t.Fatal(err)
	}
	var canonical map[string]any
	if json.Unmarshal(dagJSON, &canonical) != nil || canonical["id"] != workflowID || canonical["name"] != workflowID {
		t.Fatalf("MCP did not persist canonical identity defaults: %s", dagJSON)
	}
	if _, present := canonical["mystery"]; present || parentName != workflowID {
		t.Fatalf("MCP canonicalization drifted: parent=%q dag=%s", parentName, dagJSON)
	}
	nodes := canonical["nodes"].([]any)
	if _, present := nodes[0].(map[string]any)["unknown"]; present {
		t.Fatalf("MCP retained an unknown node carrier: %s", dagJSON)
	}
	var scheduledVersionID string
	if err := pool.QueryRow(t.Context(), `SELECT workflow_version_id FROM schedule_entries
		WHERE org_id=$1 AND workflow_id=$2 AND node_id='hourly'`, orgID, workflowID).
		Scan(&scheduledVersionID); err != nil {
		t.Fatal(err)
	}
	if scheduledVersionID != versionID {
		t.Fatalf("MCP schedule points at %s, latest version is %s", scheduledVersionID, versionID)
	}
}

func TestMcpRunStartHonorsSavedOnlyAndPausePolicies(t *testing.T) {
	session, orgID := newMCPSession(t)
	pool := poolForTest(t)
	document := map[string]any{
		"id": "mcp-run-policy-" + uuid.NewString(), "name": "MCP run policy",
		"nodes": []any{map[string]any{"id": "done", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs
		(id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'runs.requireSavedWorkflow', 'true', 'runs', 'test policy', 'boolean')`,
		uuid.NewString(), orgID); err != nil {
		t.Fatal(err)
	}

	denied, _ := callTool(t, session, "runs.start", map[string]any{"workflow": document})
	if !denied.IsError || !strings.Contains(denied.Content[0].(*mcp.TextContent).Text, "runs_adhoc_disabled") {
		t.Fatalf("MCP must honor tenant saved-only policy: %+v", denied)
	}

	_, saved := callTool(t, session, "workflows.save", map[string]any{"workflow": document})
	versionID, _ := saved["versionId"].(string)
	if versionID == "" {
		t.Fatalf("save did not return exact version: %+v", saved)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE workflows SET status='paused_circuit_breaker',
		paused_reason='test breaker' WHERE org_id=$1 AND id=$2`, orgID, document["id"]); err != nil {
		t.Fatal(err)
	}
	paused, _ := callTool(t, session, "runs.start", map[string]any{
		"workflow": document, "workflowVersionId": versionID,
	})
	if !paused.IsError || !strings.Contains(paused.Content[0].(*mcp.TextContent).Text, "workflow_circuit_breaker_paused") {
		t.Fatalf("MCP must honor circuit-breaker pause: %+v", paused)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE workflows SET status='paused_upstream_degraded',
		paused_reason='test upstream' WHERE org_id=$1 AND id=$2`, orgID, document["id"]); err != nil {
		t.Fatal(err)
	}
	upstream, _ := callTool(t, session, "runs.start", map[string]any{
		"workflow": document, "workflowVersionId": versionID,
	})
	if !upstream.IsError || !strings.Contains(upstream.Content[0].(*mcp.TextContent).Text, "upstream_degraded") {
		t.Fatalf("MCP must honor upstream pause: %+v", upstream)
	}

	var runCount int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM runs WHERE org_id=$1`, orgID).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if runCount != 0 {
		t.Fatalf("denied MCP starts must not persist runs: %d", runCount)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE workflows SET status='active', paused_reason=NULL
		WHERE org_id=$1 AND id=$2`, orgID, document["id"]); err != nil {
		t.Fatal(err)
	}
	allowed, started := callTool(t, session, "runs.start", map[string]any{
		"workflow": document, "workflowVersionId": versionID,
	})
	if allowed.IsError || started["runId"] == "" {
		t.Fatalf("active exact saved workflow must start: result=%+v payload=%+v", allowed, started)
	}
}

func TestMcpRunStartHonorsProductionReadiness(t *testing.T) {
	t.Setenv("JANUSLY_ENV", "production")
	session, orgID := newMCPSession(t)
	pool := poolForTest(t)
	document := map[string]any{
		"id": "mcp-not-ready-" + uuid.NewString(), "name": "Not ready",
		"nodes": []any{map[string]any{
			"id": "read", "type": "http",
			"config": map[string]any{"url": "https://example.invalid", "method": "GET"},
		}},
		"edges": []any{},
	}
	denied, _ := callTool(t, session, "runs.start", map[string]any{"workflow": document})
	if !denied.IsError || !strings.Contains(denied.Content[0].(*mcp.TextContent).Text, "runs_not_production_ready") {
		t.Fatalf("MCP must honor production readiness gate: %+v", denied)
	}
	var runCount int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM runs WHERE org_id=$1`, orgID).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if runCount != 0 {
		t.Fatalf("not-ready MCP start persisted %d runs", runCount)
	}
}

func mcpRolloutWorkflow(id, verdict string) map[string]any {
	return map[string]any{
		"id": id, "name": "MCP rollout", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"verdict": verdict},
			}},
			map[string]any{"id": "done", "type": "noop", "config": map[string]any{}},
		},
		"edges":   []any{map[string]any{"from": "shape", "to": "done"}},
		"outputs": map[string]any{"verdict": "{{context.shape.output.verdict}}"},
	}
}

func TestMcpRunStartCapturesActiveRolloutAssignment(t *testing.T) {
	session, orgID := newMCPSession(t)
	pool := poolForTest(t)
	workflowID := "mcp-rollout-" + uuid.NewString()
	_, baseline := callTool(t, session, "workflows.save", map[string]any{
		"workflow": mcpRolloutWorkflow(workflowID, "baseline"),
	})
	_, canary := callTool(t, session, "workflows.save", map[string]any{
		"workflow": mcpRolloutWorkflow(workflowID, "canary"),
	})
	baselineID, _ := baseline["versionId"].(string)
	canaryID, _ := canary["versionId"].(string)
	if baselineID == "" || canaryID == "" {
		t.Fatalf("missing saved rollout versions: baseline=%+v canary=%+v", baseline, canary)
	}
	kind, rollout, err := engine.New(pool).CreateWorkflowRollout(t.Context(), struct {
		OrgID, WorkflowID, BaselineVersionID, CanaryVersionID        string
		TrafficPercent, MinimumSampleSize, MinimumSuccessRatePercent int
		CreatedBy                                                    string
	}{
		OrgID: orgID, WorkflowID: workflowID,
		BaselineVersionID: baselineID, CanaryVersionID: canaryID,
		TrafficPercent: 50, MinimumSampleSize: 5, MinimumSuccessRatePercent: 90,
		CreatedBy: "mcp-test",
	})
	if err != nil || kind != engine.RolloutCreated || rollout == nil {
		t.Fatalf("create rollout: kind=%s rollout=%+v err=%v", kind, rollout, err)
	}

	result, started := callTool(t, session, "runs.start", map[string]any{
		"workflow": mcpRolloutWorkflow(workflowID, "caller-draft"),
	})
	runID, _ := started["runId"].(string)
	if result.IsError || runID == "" {
		t.Fatalf("rollout start failed: result=%+v payload=%+v", result, started)
	}
	var rolloutID, variant, versionID, verdict string
	if err := pool.QueryRow(t.Context(), `SELECT COALESCE(workflow_rollout_id, ''),
		COALESCE(workflow_rollout_variant, ''), workflow_version_id,
		input_json->'workflow'->'nodes'->0->'config'->'mapping'->>'verdict'
		FROM runs WHERE org_id=$1 AND id=$2`, orgID, runID).
		Scan(&rolloutID, &variant, &versionID, &verdict); err != nil {
		t.Fatal(err)
	}
	wantVersion := map[string]string{"baseline": baselineID, "canary": canaryID}[variant]
	wantVerdict := map[string]string{"baseline": "baseline", "canary": "canary"}[variant]
	if rolloutID != rollout.ID || wantVersion == "" || versionID != wantVersion || verdict != wantVerdict {
		t.Fatalf("MCP rollout authority drifted: rollout=%q variant=%q version=%q verdict=%q", rolloutID, variant, versionID, verdict)
	}
}

func callTool(t *testing.T, session *mcp.ClientSession, name string, args map[string]any) (*mcp.CallToolResult, map[string]any) {
	t.Helper()
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: transport error %v", name, err)
	}
	var parsed map[string]any
	if len(res.Content) > 0 {
		if text, ok := res.Content[0].(*mcp.TextContent); ok {
			_ = json.Unmarshal([]byte(text.Text), &parsed)
		}
	}
	return res, parsed
}

func TestAgentDrivesFailureRedriveCycleOverMCP(t *testing.T) {
	session, _ := newMCPSession(t)

	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		names[tool.Name] = true
	}
	for _, want := range []string{
		"workflows.save", "workflows.assure", "workflows.propose",
		"runs.start", "runs.status", "runs.inspect", "runs.list", "workflows.list",
		"dlq.list", "dlq.redrive", "operations.brief",
		"recovery.cases.inspect", "recovery.cases.diagnose", "recovery.cases.validate", "recovery.cases.apply",
	} {
		if !names[want] {
			t.Fatalf("tool %s missing; got %v", want, names)
		}
	}

	var healed bool
	var mu sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ok := healed
		mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"restored":true}`))
	}))
	defer upstream.Close()

	workflow := map[string]any{
		"id":   "mcp-wedge-" + fmt.Sprint(time.Now().UnixNano()),
		"name": "MCP wedge",
		"nodes": []any{
			map[string]any{"id": "call", "type": "http", "config": map[string]any{
				"url":   upstream.URL,
				"retry": map[string]any{"maxAttempts": 2, "delayMs": 50},
			}},
		},
		"edges": []any{},
	}

	saveRes, saved := callTool(t, session, "workflows.save", map[string]any{"workflow": workflow})
	if saveRes.IsError {
		t.Fatalf("save error: %s", saveRes.Content[0].(*mcp.TextContent).Text)
	}
	if saved["version"] != float64(1) {
		t.Fatalf("save: %v", saved)
	}

	_, started := callTool(t, session, "runs.start", map[string]any{"workflow": workflow})
	runID, _ := started["runId"].(string)
	if runID == "" {
		t.Fatalf("start: %v", started)
	}

	waitStatus := func(want string) map[string]any {
		deadline := time.Now().Add(20 * time.Second)
		for {
			_, status := callTool(t, session, "runs.status", map[string]any{"runId": runID})
			if status["status"] == want {
				return status
			}
			if time.Now().After(deadline) {
				t.Fatalf("run stuck: %v, want %s", status["status"], want)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	waitStatus("failed")

	_, dlq := callTool(t, session, "dlq.list", map[string]any{"limit": 50})
	var deadLetterID string
	for _, raw := range dlq["deadLetters"].([]any) {
		row := raw.(map[string]any)
		if row["runId"] == runID {
			deadLetterID = row["id"].(string)
		}
	}
	if deadLetterID == "" {
		t.Fatalf("dead letter expected: %v", dlq)
	}

	mu.Lock()
	healed = true
	mu.Unlock()
	redriveRes, redriven := callTool(t, session, "dlq.redrive", map[string]any{"deadLetterId": deadLetterID})
	if redriveRes.IsError || redriven["redriven"] != true {
		t.Fatalf("redrive: %v %v", redriveRes.IsError, redriven)
	}
	waitStatus("succeeded")

	// Expected-failure posture: a second redrive is an isError result with a
	// readable message, never a transport error.
	conflict, _ := callTool(t, session, "dlq.redrive", map[string]any{"deadLetterId": deadLetterID})
	if !conflict.IsError {
		t.Fatal("double redrive must be an isError tool result")
	}
	text := conflict.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(text, "already claimed") {
		t.Fatalf("conflict message: %s", text)
	}

	// Inspect returns the timeline an operator would read.
	_, inspected := callTool(t, session, "runs.inspect", map[string]any{"runId": runID})
	if inspected["status"] != "succeeded" {
		t.Fatalf("inspect: %v", inspected["status"])
	}
	events, _ := inspected["recentEvents"].([]any)
	sawRedriven := false
	for _, raw := range events {
		if raw.(map[string]any)["type"] == "node.redriven" {
			sawRedriven = true
		}
	}
	if !sawRedriven {
		t.Fatal("timeline must carry node.redriven")
	}

	// Unknown run: expected failure, structured.
	ghost, _ := callTool(t, session, "runs.status", map[string]any{"runId": "ghost"})
	if !ghost.IsError {
		t.Fatal("unknown run must be an isError result")
	}
}

func fullMCPTestPermissions() map[string]bool {
	return map[string]bool{
		"workflows.read": true, "workflows.write": true,
		"runs.read": true, "runs.start": true,
		"dlq.read": true, "dlq.replay": true,
		"recovery.read": true, "recovery.write": true,
		"ai.write": true,
	}
}

func TestMcpWorkflowAssuranceProjection(t *testing.T) {
	session, orgID := newMCPSession(t)
	pack := packs.Get("failed-payment-recovery")
	if pack == nil {
		t.Fatal("flagship pack missing")
	}
	var workflow map[string]any
	if err := json.Unmarshal(pack.WorkflowJSON, &workflow); err != nil {
		t.Fatal(err)
	}
	workflowID := fmt.Sprintf("mcp-assure-%d", time.Now().UnixNano())
	workflow["id"] = workflowID
	if res, _ := callTool(t, session, "workflows.save", map[string]any{"workflow": workflow}); res.IsError {
		t.Fatalf("save flagship: %s", res.Content[0].(*mcp.TextContent).Text)
	}

	res, assured := callTool(t, session, "workflows.assure", map[string]any{"workflowId": workflowID})
	if res.IsError || assured["status"] != "qualified" || assured["version"] != float64(1) {
		t.Fatalf("assurance projection: error=%v payload=%+v", res.IsError, assured)
	}
	intent := assured["intent"].(map[string]any)
	recoveryContract := assured["recovery"].(map[string]any)
	qualification := assured["qualification"].(map[string]any)
	if intent["declared"] != true || recoveryContract["version"] != "2" ||
		qualification["status"] != "qualified" || qualification["fixturesReplayPassed"] != true {
		t.Fatalf("assurance evidence incomplete: intent=%+v recovery=%+v qualification=%+v",
			intent, recoveryContract, qualification)
	}
	raw, _ := json.Marshal(assured)
	for _, forbidden := range []string{`"nodes"`, `"edges"`, `"config"`, "billing_webhook", "billing_slack"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("assurance projection leaked DAG/config %q: %s", forbidden, raw)
		}
	}

	// Tenant invisibility: even a real workflow/version in another org is
	// indistinguishable from an unknown id to this scoped MCP session.
	pool := poolForTest(t)
	foreignID := "foreign-" + workflowID
	if _, err := pool.Exec(t.Context(), `INSERT INTO workflows (id, org_id, name) VALUES ($1, $2, 'foreign')`, foreignID, orgID+"-foreign"); err != nil {
		t.Fatal(err)
	}
	foreign, _ := callTool(t, session, "workflows.assure", map[string]any{"workflowId": foreignID})
	if !foreign.IsError || foreign.Content[0].(*mcp.TextContent).Text != "workflow not found" {
		t.Fatal("foreign workflow must remain invisible")
	}
}

// The inspect list tools paginate by keyset: page one carries nextCursor,
// page two picks up exactly where it left off, filters narrow runs.
func TestMcpListToolsPaginate(t *testing.T) {
	session, _ := newMCPSession(t)

	for i := range 3 {
		doc := map[string]any{
			"id":    fmt.Sprintf("mcp-page-%d-%d", i, time.Now().UnixNano()),
			"name":  fmt.Sprintf("paged %d", i),
			"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
			"edges": []any{},
		}
		if res, _ := callTool(t, session, "workflows.save", map[string]any{"workflow": doc}); res.IsError {
			t.Fatalf("save %d failed", i)
		}
		if res, _ := callTool(t, session, "runs.start", map[string]any{"workflow": doc}); res.IsError {
			t.Fatalf("start %d failed", i)
		}
	}

	_, page1 := callTool(t, session, "workflows.list", map[string]any{"limit": 2})
	rows1 := page1["workflows"].([]any)
	if len(rows1) != 2 || page1["hasMore"] != true || page1["nextCursor"] == nil {
		t.Fatalf("page1: %+v", page1)
	}
	_, page2 := callTool(t, session, "workflows.list", map[string]any{
		"limit": 2, "cursor": page1["nextCursor"].(string),
	})
	rows2 := page2["workflows"].([]any)
	if len(rows2) != 1 || page2["hasMore"] != false {
		t.Fatalf("page2: %+v", page2)
	}
	if rows1[0].(map[string]any)["workflowId"] == rows2[0].(map[string]any)["workflowId"] {
		t.Fatal("pages must not overlap")
	}

	_, runsPage := callTool(t, session, "runs.list", map[string]any{"limit": 2})
	if len(runsPage["runs"].([]any)) != 2 || runsPage["hasMore"] != true {
		t.Fatalf("runs page: %+v", runsPage)
	}
	wfID := rows2[0].(map[string]any)["workflowId"].(string)
	_, filtered := callTool(t, session, "runs.list", map[string]any{"workflowId": wfID})
	if len(filtered["runs"].([]any)) != 1 || filtered["hasMore"] != false {
		t.Fatalf("filtered runs: %+v", filtered)
	}
}

// The write-consent denial ladder: process flag off → verbatim process
// message; flag on without tenant consent → verbatim tenant message.
// Read tools stay available throughout.
func TestMcpWriteConsentLadder(t *testing.T) {
	session, orgID := newMCPSession(t)
	doc := map[string]any{
		"id":    fmt.Sprintf("mcp-consent-%d", time.Now().UnixNano()),
		"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}

	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "")
	res, _ := callTool(t, session, "workflows.save", map[string]any{"workflow": doc})
	if !res.IsError {
		t.Fatal("process-level denial expected")
	}
	text := res.Content[0].(*mcp.TextContent).Text
	if text != "MCP writes are disabled at the process level (JANUSLY_MCP_WRITES_ENABLED is not 'true')." {
		t.Fatalf("process message drifted: %q", text)
	}

	// Read tools are never gated.
	if res, _ := callTool(t, session, "workflows.list", map[string]any{}); res.IsError {
		t.Fatal("reads must not be gated")
	}

	// Flag on, tenant consent revoked → the tenant message.
	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "true")
	pool := poolForTest(t)
	if _, err := pool.Exec(context.Background(),
		`UPDATE org_configs SET value_json = 'false' WHERE org_id = $1 AND key = 'mcp.writeConsent'`,
		orgID); err != nil {
		t.Fatalf("revoke consent: %v", err)
	}
	res, _ = callTool(t, session, "runs.start", map[string]any{"workflow": doc})
	if !res.IsError {
		t.Fatal("tenant-level denial expected")
	}
	text = res.Content[0].(*mcp.TextContent).Text
	if text != "MCP writes are not consented for this organization (mcp.writeConsent is false)." {
		t.Fatalf("tenant message drifted: %q", text)
	}
}

func poolForTest(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("JANUSLY_DATABASE_URL"))
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}
