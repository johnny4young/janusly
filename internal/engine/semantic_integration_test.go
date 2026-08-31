//go:build integration

package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

func semanticWorkflow(id, action string, passWhen string) *domain.Workflow {
	contract := &domain.RecoveryContract{Version: "2"}
	contract.Failure.Technical.TerminalNodeFailure = true
	contract.Failure.Semantic.Mode = "deterministic"
	contract.Failure.Semantic.Detectors = []domain.RecoverySemanticDetector{{
		ID: "det-total", SourceNodeID: "calc", Kind: "expression",
		PassWhen: passWhen, Action: action, Message: "total out of bounds",
	}}
	contract.Failure.Semantic.EvaluationFixtures = []domain.RecoverySemanticFixture{
		{ID: "fx-pass", SourceNodeID: "calc", Output: map[string]any{"total": "10"}, Expected: "pass"},
		{ID: "fx-violation", SourceNodeID: "calc", Output: map[string]any{"total": "900"}, Expected: "violation"},
	}
	contract.Evidence.Required = []string{"failure_snapshot", "audit_trail", "terminal_outcome"}
	contract.Repairs.Allowed = []string{"retry"}
	contract.Validation.MinimumEvidenceLevel = "static"
	contract.Approval.ProductionMutation = "required"
	contract.Approval.Permission = "recovery.write"
	contract.AutonomyLevel = 2
	contract.Verification.Kind = "generation_bound_terminal_success"
	contract.Recurrence.WindowDays = 7
	return &domain.Workflow{
		ID: id, Name: "Semantic", DSLVersion: "1.0",
		Recovery: &domain.WorkflowRecovery{Contract: contract},
		Nodes: []domain.Node{
			{ID: "calc", Type: "transform", Config: map[string]any{
				"mapping": map[string]any{"total": "{{context.input.total}}"},
			}},
			{ID: "after", Type: "noop", Config: map[string]any{}},
		},
		Edges: []domain.Edge{{From: "calc", To: "after"}},
	}
}

// The observe/quarantine runtime split: observe records the case without
// pausing, quarantine parks the run in waiting BEFORE downstream runs,
// and a sandbox replay creates NO durable cases.
func TestSemanticOutcomeInterception(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()
	org := fmt.Sprintf("org-semantic-%d", time.Now().UnixNano())

	// String comparison keeps the transform template deterministic: the
	// mapping renders text, so the detector compares strings length-first.
	passWhen := "context.calc.output.total === '10'"

	// 1. Observe: violation recorded, run still completes, downstream ran.
	runID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: semanticWorkflow("wf-observe", "observe", passWhen),
		Input: map[string]any{"total": "900"},
	})
	if err != nil {
		t.Fatalf("start observe: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	var outcomeStatus string
	var violationCount int
	_ = pool.QueryRow(ctx, `SELECT COALESCE(outcome_status,''), semantic_violation_count FROM runs WHERE id = $1`, runID).
		Scan(&outcomeStatus, &violationCount)
	if outcomeStatus != "semantic_violation" || violationCount != 1 {
		t.Fatalf("observe outcome: %s/%d", outcomeStatus, violationCount)
	}
	var caseState, caseAction string
	_ = pool.QueryRow(ctx, `SELECT state, action FROM recovery_cases WHERE org_id = $1 AND run_id = $2`, org, runID).
		Scan(&caseState, &caseAction)
	if caseState != "detected" || caseAction != "observe" {
		t.Fatalf("observe case: %s/%s", caseState, caseAction)
	}

	// 2. Quarantine: node succeeded + case contained + run WAITING, and the
	// downstream node never scheduled.
	runID, err = eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: semanticWorkflow("wf-quarantine", "quarantine", passWhen),
		Input: map[string]any{"total": "900"},
	})
	if err != nil {
		t.Fatalf("start quarantine: %v", err)
	}
	waitRunStatus(t, pool, runID, "waiting", 0)
	var nodeStatus, afterStatus string
	_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id = $1 AND node_id = 'calc'`, runID).Scan(&nodeStatus)
	_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id = $1 AND node_id = 'after'`, runID).Scan(&afterStatus)
	if nodeStatus != "succeeded" || afterStatus != "pending" {
		t.Fatalf("quarantine must gate downstream: calc=%s after=%s", nodeStatus, afterStatus)
	}
	_ = pool.QueryRow(ctx, `SELECT state FROM recovery_cases WHERE org_id = $1 AND run_id = $2`, org, runID).Scan(&caseState)
	if caseState != "contained" {
		t.Fatalf("quarantine case must contain: %s", caseState)
	}
	var receiptCount, eventCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM recovery_case_transitions t
		JOIN recovery_cases c ON c.id = t.case_id WHERE c.run_id = $1`, runID).Scan(&receiptCount)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1 AND type = 'recovery.semantic_violation'`, runID).Scan(&eventCount)
	if receiptCount != 1 || eventCount != 1 {
		t.Fatalf("containment receipt+event: %d/%d", receiptCount, eventCount)
	}
	_ = pool.QueryRow(ctx, `SELECT COALESCE(outcome_status,'') FROM runs WHERE id = $1`, runID).Scan(&outcomeStatus)
	if outcomeStatus != "semantic_quarantined" {
		t.Fatalf("quarantine outcome status: %s", outcomeStatus)
	}

	// 3. A PASSING output creates nothing and completes normally.
	runID, err = eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: semanticWorkflow("wf-clean", "quarantine", passWhen),
		Input: map[string]any{"total": "10"},
	})
	if err != nil {
		t.Fatalf("start clean: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	var cleanCases int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM recovery_cases WHERE run_id = $1`, runID).Scan(&cleanCases)
	if cleanCases != 0 {
		t.Fatalf("clean run must create no cases: %d", cleanCases)
	}

	// 4. Sandbox replay (validation) NEVER creates durable cases.
	runID, err = eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: semanticWorkflow("wf-sandbox", "quarantine", passWhen),
		Input: map[string]any{"total": "900"}, ReplayMode: "validation",
	})
	if err != nil {
		t.Fatalf("start sandbox: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	var sandboxCases int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM recovery_cases WHERE run_id = $1`, runID).Scan(&sandboxCases)
	if sandboxCases != 0 {
		t.Fatalf("sandbox must create no cases: %d", sandboxCases)
	}
}

// The governed operator path is intentionally provider-free: immutable
// artifacts bind validation and a 30-minute human grant to one case revision;
// exactly one concurrent apply can consume the grant, publish the replacement,
// verify the outcome and resume downstream work.
func TestGovernedSemanticRecoveryLifecycle(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()

	org := fmt.Sprintf("org-governed-semantic-%d", time.Now().UnixNano())
	wf := semanticWorkflow("wf-governed", "quarantine", "context.calc.output.total === '10'")
	wf.Recovery.Contract.AutonomyLevel = 3
	runID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: wf, Input: map[string]any{"total": "900"}, CreatedBy: "editor-1",
	})
	if err != nil {
		t.Fatalf("start quarantined run: %v", err)
	}
	waitRunStatus(t, pool, runID, "waiting", 0)

	var caseID, state string
	var revision int64
	if err := pool.QueryRow(ctx, `SELECT id, state, revision FROM recovery_cases WHERE org_id = $1 AND run_id = $2`, org, runID).
		Scan(&caseID, &state, &revision); err != nil {
		t.Fatalf("read contained case: %v", err)
	}
	if state != "contained" {
		t.Fatalf("initial governed state = %s", state)
	}
	actor := &auth.Context{OrgID: org, UserID: "editor-1", Mode: auth.ModeDevHeaders, Source: auth.SourceWeb}

	diagnosed, err := eng.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: revision,
		Artifacts: []RecoveryArtifactInput{{Kind: "diagnosis", Payload: map[string]any{
			"mode": "deterministic_fallback", "summary": "semantic detector rejected source output",
		}}},
		Steps:       []RecoveryTransitionStep{{From: "contained", To: "diagnosed", Reason: "deterministic diagnosis recorded"}},
		AuditAction: audit.Action("recovery.case.diagnosed"),
	})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	evidence := []domain.RecoveryCaseEvidenceRef{
		{Kind: "run", ID: runID}, {Kind: "run_node", ID: runID + ":calc"},
		{Kind: "semantic_detector", ID: "det-total"},
	}
	candidates, err := eng.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: diagnosed.Case.Revision,
		Artifacts: []RecoveryArtifactInput{{Kind: "candidate", Payload: SemanticRecoveryCandidatePayload{
			Kind: "replace_output", Decision: "replace", Output: map[string]any{"total": "10"},
			Reason: "restore the contractually valid total", Risk: "medium", Evidence: evidence,
			ExpectedResult: "all deterministic detectors pass", RequiredPermissions: []string{"recovery.write"},
		}}},
		Steps:       []RecoveryTransitionStep{{From: "diagnosed", To: "candidates_ready", Reason: "bounded candidate recorded"}},
		AuditAction: audit.Action("recovery.case.candidates_created"),
	})
	if err != nil {
		t.Fatalf("candidate: %v", err)
	}
	candidate := candidates.Artifacts[0]
	validationPayload, err := eng.ValidateSemanticRecoveryCandidate(ctx, org, caseID, candidate.ID)
	if err != nil || !validationPayload.Passed {
		t.Fatalf("validate candidate: passed=%v err=%v summary=%s", validationPayload.Passed, err, validationPayload.Summary)
	}
	validated, err := eng.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: candidates.Case.Revision,
		Artifacts: []RecoveryArtifactInput{{Kind: "validation", Payload: validationPayload}},
		Steps: []RecoveryTransitionStep{
			{From: "candidates_ready", To: "validating", Reason: "candidate validation started"},
			{From: "validating", To: "awaiting_approval", Reason: validationPayload.Summary},
		},
		AuditAction: audit.Action("recovery.case.validated"),
	})
	if err != nil {
		t.Fatalf("persist validation: %v", err)
	}
	validation := validated.Artifacts[0]

	// An expired grant can be superseded without changing the case revision.
	base := time.Now().UTC().Truncate(time.Millisecond)
	eng.now = func() time.Time { return base.Add(-31 * time.Minute) }
	expired, err := eng.ApproveRecoveryCandidate(ctx, ApproveRecoveryCandidateInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: validated.Case.Revision,
		CandidateArtifactID: candidate.ID, ValidationArtifactID: validation.ID,
	})
	if err != nil {
		t.Fatalf("create expiring approval: %v", err)
	}
	eng.now = func() time.Time { return base }
	active, err := eng.ApproveRecoveryCandidate(ctx, ApproveRecoveryCandidateInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: validated.Case.Revision,
		CandidateArtifactID: candidate.ID, ValidationArtifactID: validation.ID,
	})
	if err != nil {
		t.Fatalf("renew approval: %v", err)
	}
	if active.ID == expired.ID || !active.ExpiresAt.Equal(base.Add(30*time.Minute)) {
		t.Fatalf("approval renewal did not create a fresh 30-minute grant: old=%s new=%s expires=%s", expired.ID, active.ID, active.ExpiresAt)
	}

	input := ResolveSemanticOutcomeInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: validated.Case.Revision,
		CandidateArtifactID: candidate.ID, ValidationArtifactID: validation.ID,
	}
	var wg sync.WaitGroup
	results := make([]ResolveSemanticOutcomeResult, 2)
	errs := make([]error, 2)
	for index := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[index], errs[index] = eng.ResolveSemanticOutcomeCase(ctx, input)
		}()
	}
	wg.Wait()
	winners := 0
	var applied ResolveSemanticOutcomeResult
	for index, applyErr := range errs {
		if applyErr == nil {
			winners++
			applied = results[index]
			continue
		}
		if !errors.Is(applyErr, ErrRecoveryCaseConflict) {
			t.Fatalf("apply loser must fail closed: %v", applyErr)
		}
	}
	if winners != 1 || !applied.Resumed || applied.Decision != "replace" {
		t.Fatalf("exactly one governed apply must resume: winners=%d result=%+v errors=%v", winners, applied, errs)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)

	if err := pool.QueryRow(ctx, `SELECT state, revision FROM recovery_cases WHERE org_id = $1 AND id = $2`, org, caseID).
		Scan(&state, &revision); err != nil {
		t.Fatalf("read resolved case: %v", err)
	}
	if state != "verified_recovered" || revision != validated.Case.Revision+3 {
		t.Fatalf("terminal state/revision = %s/%d, want verified_recovered/%d", state, revision, validated.Case.Revision+3)
	}
	var artifacts, publication, verification, receipts int
	if err := pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE kind='publication'), count(*) FILTER (WHERE kind='verification')
		FROM recovery_case_artifacts WHERE org_id=$1 AND case_id=$2`, org, caseID).
		Scan(&artifacts, &publication, &verification); err != nil {
		t.Fatalf("count artifacts: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM recovery_case_transitions WHERE org_id=$1 AND case_id=$2`, org, caseID).Scan(&receipts); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if artifacts != 5 || publication != 1 || verification != 1 || receipts != 8 {
		t.Fatalf("governed evidence incomplete: artifacts=%d publication=%d verification=%d receipts=%d", artifacts, publication, verification, receipts)
	}
	var grantCount, revokedCount, consumedCount int
	if err := pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE revoked_at IS NOT NULL), count(*) FILTER (WHERE consumed_at IS NOT NULL)
		FROM recovery_approval_grants WHERE org_id=$1 AND case_id=$2`, org, caseID).
		Scan(&grantCount, &revokedCount, &consumedCount); err != nil {
		t.Fatalf("count grants: %v", err)
	}
	if grantCount != 2 || revokedCount != 1 || consumedCount != 1 {
		t.Fatalf("grant lifecycle = total:%d revoked:%d consumed:%d", grantCount, revokedCount, consumedCount)
	}
}
