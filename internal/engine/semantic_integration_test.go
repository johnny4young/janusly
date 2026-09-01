//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
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
// exactly one concurrent apply can consume the grant, publish the replacement
// into monitoring and resume downstream work; only terminal generation success
// may append verification and close the case.
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
	startWorkers := func() (context.CancelFunc, <-chan struct{}) {
		workerCtx, stop := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger())
		}()
		return stop, done
	}
	stop, workersDone := startWorkers()
	defer func() {
		stop()
		<-workersDone
	}()

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
	stop()
	<-workersDone

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

	// Any later case revision expires the validation binding, even when the
	// immutable candidate itself is unchanged. Return to candidates_ready,
	// validate again, and prove the former artifact cannot be approved.
	reopened, err := eng.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: validated.Case.Revision,
		Steps: []RecoveryTransitionStep{{
			From: "awaiting_approval", To: "candidates_ready", Reason: "Operator requested fresh validation",
		}},
		AuditAction: audit.Action("recovery.case.validated"),
	})
	if err != nil {
		t.Fatalf("reopen for validation freshness: %v", err)
	}
	revalidated, err := eng.ValidateRecoveryCaseCandidate(ctx, ValidateRecoveryCaseCandidateInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: reopened.Case.Revision,
		CandidateArtifactID: candidate.ID,
	})
	if err != nil || !revalidated.Passed {
		t.Fatalf("fresh candidate validation: passed=%v err=%v", revalidated.Passed, err)
	}
	if _, err := eng.ApproveRecoveryCandidate(ctx, ApproveRecoveryCandidateInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: revalidated.Case.Revision,
		CandidateArtifactID: candidate.ID, ValidationArtifactID: validation.ID,
	}); !errors.Is(err, ErrRecoveryCaseConflict) {
		t.Fatalf("stale validation must fail closed, got %v", err)
	}
	validated.Case = revalidated.Case
	validation = revalidated.Validation

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
	if err := pool.QueryRow(ctx, `SELECT state, revision FROM recovery_cases WHERE org_id = $1 AND id = $2`, org, caseID).
		Scan(&state, &revision); err != nil {
		t.Fatalf("read monitoring case: %v", err)
	}
	if state != "monitoring" || revision != validated.Case.Revision+2 {
		t.Fatalf("apply state/revision = %s/%d, want monitoring/%d", state, revision, validated.Case.Revision+2)
	}
	var monitoringOutcome string
	if err := pool.QueryRow(ctx, `SELECT coalesce(outcome_status, '') FROM runs WHERE id=$1 AND org_id=$2`, runID, org).
		Scan(&monitoringOutcome); err != nil {
		t.Fatalf("read monitoring run outcome: %v", err)
	}
	if monitoringOutcome != "semantic_recovering" {
		t.Fatalf("monitoring run outcome = %q, want semantic_recovering", monitoringOutcome)
	}
	var beforeTerminalPublication, beforeTerminalVerification int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE kind='publication'), count(*) FILTER (WHERE kind='verification')
		FROM recovery_case_artifacts WHERE org_id=$1 AND case_id=$2`, org, caseID).
		Scan(&beforeTerminalPublication, &beforeTerminalVerification); err != nil {
		t.Fatalf("count monitoring artifacts: %v", err)
	}
	if beforeTerminalPublication != 1 || beforeTerminalVerification != 0 {
		t.Fatalf("monitoring evidence = publication:%d verification:%d, want 1/0", beforeTerminalPublication, beforeTerminalVerification)
	}
	stop, workersDone = startWorkers()
	waitRunStatus(t, pool, runID, "succeeded", 0)

	if err := pool.QueryRow(ctx, `SELECT state, revision FROM recovery_cases WHERE org_id = $1 AND id = $2`, org, caseID).
		Scan(&state, &revision); err != nil {
		t.Fatalf("read resolved case: %v", err)
	}
	if state != "verified_recovered" || revision != validated.Case.Revision+3 {
		t.Fatalf("terminal state/revision = %s/%d, want verified_recovered/%d", state, revision, validated.Case.Revision+3)
	}
	var verifiedOutcome string
	if err := pool.QueryRow(ctx, `SELECT coalesce(outcome_status, '') FROM runs WHERE id=$1 AND org_id=$2`, runID, org).
		Scan(&verifiedOutcome); err != nil {
		t.Fatalf("read verified run outcome: %v", err)
	}
	if verifiedOutcome != "semantic_recovered" {
		t.Fatalf("verified run outcome = %q, want semantic_recovered", verifiedOutcome)
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
	// The stale-validation proof above deliberately adds one replacement
	// validation artifact and three lifecycle receipts (reopen plus the
	// validating round trip) before the normal publication/verification path.
	if artifacts != 6 || publication != 1 || verification != 1 || receipts != 11 {
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

// A published replacement is not a verified recovery when its resumed
// generation fails or is cancelled. Both terminal paths atomically clear the
// monitoring run outcome, record bounded failure evidence and close the case
// as recurred.
func TestSemanticRecoveryTerminalFailureRecurs(t *testing.T) {
	for _, terminalStatus := range []string{"failed", "cancelled"} {
		t.Run(terminalStatus, func(t *testing.T) {
			assertSemanticRecoveryTerminalRecurred(t, terminalStatus)
		})
	}
}

func assertSemanticRecoveryTerminalRecurred(t *testing.T, terminalStatus string) {
	t.Helper()
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
	nonce := terminalStatus + "-" + fmt.Sprint(time.Now().UnixNano())
	orgID := "org-semantic-terminal-" + nonce
	runID := "run-semantic-terminal-" + nonce
	caseID := "case-semantic-terminal-" + nonce
	publicationID := "publication-semantic-terminal-" + nonce
	if _, err := pool.Exec(ctx, `
		INSERT INTO runs (id, org_id, workflow_version_id, status, input_json, outcome_status)
		VALUES ($1, $2, 'version-terminal', 'running', '{}'::jsonb, 'semantic_recovering')`,
		runID, orgID); err != nil {
		t.Fatalf("insert monitoring run: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO recovery_cases (
			id, org_id, run_id, workflow_version_id, source, detector_id,
			source_node_id, detector_kind, action, message, state, revision
		) VALUES ($1, $2, $3, 'version-terminal', 'semantic_violation',
			'det-terminal', 'source-terminal', 'expression', 'quarantine',
			'terminal verification', 'monitoring', 8)`, caseID, orgID, runID); err != nil {
		t.Fatalf("insert monitoring case: %v", err)
	}
	publicationPayload := map[string]any{
		"caseId": caseID, "runId": runID, "decision": "replace",
		"candidateArtifactId":  "candidate-terminal",
		"candidateSha256":      strings.Repeat("a", 64),
		"validationArtifactId": "validation-terminal",
		"validationSha256":     strings.Repeat("b", 64),
	}
	publicationRaw, publicationHash, err := boundedRecoveryArtifact(publicationPayload)
	if err != nil {
		t.Fatalf("bound publication: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO recovery_case_artifacts (
			id, org_id, case_id, kind, payload_json, payload_sha256,
			actor_kind, actor_id, created_at
		) VALUES ($1, $2, $3, 'publication', $4, $5, 'user', 'editor-1', $6)`,
		publicationID, orgID, caseID, publicationRaw, publicationHash,
		time.Now().UTC().Add(-time.Second)); err != nil {
		t.Fatalf("insert publication: %v", err)
	}

	if terminalStatus == "cancelled" {
		if err := eng.CancelRun(ctx, runID, map[string]any{"reason": "semantic test"}); err != nil {
			t.Fatalf("cancel monitoring run: %v", err)
		}
	} else {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin terminal transaction: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		q := store.New(eng.wrapTx(tx))
		events := &runEventBuffer{}
		terminalAt := time.Now().UTC().Truncate(time.Millisecond)
		if err := eng.flipRunTerminal(
			ctx, q, events, runID, terminalStatus,
			map[string]any{"failedNodes": 1}, terminalAt, nil,
		); err != nil {
			t.Fatalf("flip %s run: %v", terminalStatus, err)
		}
		if err := events.flush(ctx, q); err != nil {
			t.Fatalf("flush terminal events: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit terminal transaction: %v", err)
		}
	}

	var state, outcome string
	var revision int64
	if err := pool.QueryRow(ctx, `
		SELECT c.state, c.revision, coalesce(r.outcome_status, '')
		FROM recovery_cases c JOIN runs r ON r.id = c.run_id AND r.org_id = c.org_id
		WHERE c.org_id = $1 AND c.id = $2`, orgID, caseID).
		Scan(&state, &revision, &outcome); err != nil {
		t.Fatalf("read recurred case: %v", err)
	}
	if state != "recurred" || revision != 9 || outcome != "" {
		t.Fatalf("terminal failure state/revision/outcome = %s/%d/%q, want recurred/9/empty", state, revision, outcome)
	}
	var verificationRaw []byte
	if err := pool.QueryRow(ctx, `
		SELECT payload_json FROM recovery_case_artifacts
		WHERE org_id=$1 AND case_id=$2 AND kind='verification'`, orgID, caseID).
		Scan(&verificationRaw); err != nil {
		t.Fatalf("read terminal verification: %v", err)
	}
	var verification map[string]any
	if json.Unmarshal(verificationRaw, &verification) != nil ||
		verification["terminalStatus"] != terminalStatus ||
		verification["resultState"] != "recurred" ||
		verification["generationBoundTerminalSuccess"] != false {
		t.Fatalf("terminal verification payload: %s", verificationRaw)
	}
	terminalEventID, _ := verification["eventId"].(string)
	var terminalEvents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM run_events
		WHERE run_id=$1 AND id=$2 AND type=$3`,
		runID, terminalEventID, "run."+terminalStatus,
	).Scan(&terminalEvents); err != nil {
		t.Fatalf("count exact terminal event: %v", err)
	}
	if terminalEvents != 1 {
		t.Fatalf("verification must bind one exact run.%s event: %d", terminalStatus, terminalEvents)
	}
	var systemTransitions int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM recovery_case_transitions
		WHERE org_id=$1 AND case_id=$2 AND from_state='monitoring'
		  AND to_state='recurred' AND actor_kind='system'`, orgID, caseID).
		Scan(&systemTransitions); err != nil {
		t.Fatalf("count terminal transitions: %v", err)
	}
	if systemTransitions != 1 {
		t.Fatalf("terminal failure must write one system transition: %d", systemTransitions)
	}
}
