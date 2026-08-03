//go:build integration

package engine

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

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
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
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
