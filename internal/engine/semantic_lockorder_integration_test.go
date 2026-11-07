//go:build integration

package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
)

// pauseBeforeRunLock runs onPause once, inside the semantic resolution
// transaction, right before it locks the runs row.
type pauseBeforeRunLock struct {
	store.DBTX
	once    *atomic.Bool
	onPause func(tx store.DBTX)
}

func (p *pauseBeforeRunLock) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "-- name: LockRunForSemanticResolution ") && p.once.CompareAndSwap(false, true) {
		p.onPause(p.DBTX)
	}
	return p.DBTX.QueryRow(ctx, sql, args...)
}

// Cancel and semantic resolution of the same quarantined run must serialize
// on the run's completion lock instead of deadlocking on row locks.
func TestSemanticResolutionSerializesWithCancel(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx, cancelCtx := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancelCtx()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)

	org := fmt.Sprintf("org-semantic-lockorder-%d", time.Now().UnixNano())
	runID, input := quarantinedRunWithApprovedReplacement(ctx, t, eng, pool, org)

	var paused atomic.Bool
	var pauseErr error
	cancelDone := make(chan error, 1)
	eng.wrapTx = func(tx store.DBTX) store.DBTX {
		return &pauseBeforeRunLock{DBTX: tx, once: &paused, onPause: func(tx store.DBTX) {
			var resolverPID int32
			if err := tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&resolverPID); err != nil {
				pauseErr = fmt.Errorf("resolver pid: %w", err)
				return
			}
			go func() { cancelDone <- eng.CancelRun(ctx, runID, map[string]any{"reason": "lock order"}) }()
			pauseErr = waitUntilBlockedBy(ctx, pool, resolverPID, cancelDone)
		}}
	}

	result, resolveErr := eng.ResolveSemanticOutcomeCase(ctx, input)
	cancelErr := <-cancelDone
	if pauseErr != nil {
		t.Fatalf("coordinate cancel: %v", pauseErr)
	}
	if resolveErr != nil || cancelErr != nil {
		t.Fatalf("both operations must commit serially: resolve=%v cancel=%v", resolveErr, cancelErr)
	}
	if !result.Resumed || result.Decision != "replace" {
		t.Fatalf("resolution did not apply before the cancel: %+v", result)
	}

	var runStatus, caseState string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&runStatus); err != nil {
		t.Fatalf("read run: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT state FROM recovery_cases WHERE org_id = $1 AND id = $2`,
		org, input.CaseID).Scan(&caseState); err != nil {
		t.Fatalf("read case: %v", err)
	}
	if runStatus != "cancelled" || caseState == "awaiting_approval" {
		t.Fatalf("final state: run=%s case=%s", runStatus, caseState)
	}
	var resolvedSeq, cancelledSeq int64
	if err := pool.QueryRow(ctx, `SELECT
		COALESCE(max(seq) FILTER (WHERE type = 'recovery.semantic_resolved'), 0),
		COALESCE(max(seq) FILTER (WHERE type = 'run.cancelled'), 0)
		FROM run_events WHERE run_id = $1`, runID).Scan(&resolvedSeq, &cancelledSeq); err != nil {
		t.Fatalf("read events: %v", err)
	}
	if resolvedSeq == 0 || cancelledSeq <= resolvedSeq {
		t.Fatalf("events out of commit order: resolved=%d cancelled=%d", resolvedSeq, cancelledSeq)
	}
}

// waitUntilBlockedBy returns once another backend waits on pid, or once the
// cancel finished without waiting.
func waitUntilBlockedBy(ctx context.Context, pool *pgxpool.Pool, pid int32, cancelDone chan error) error {
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-cancelDone:
			cancelDone <- err
			return nil
		default:
		}
		var blocked bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("cancel neither blocked nor finished")
}

func quarantinedRunWithApprovedReplacement(
	ctx context.Context, t *testing.T, eng *Engine, pool *pgxpool.Pool, org string,
) (string, ResolveSemanticOutcomeInput) {
	t.Helper()
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(ctx)
	workersDone := make(chan struct{})
	go func() {
		defer close(workersDone)
		_ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger())
	}()
	wf := semanticWorkflow("wf-lock-order", "quarantine", "context.calc.output.total === '10'")
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

	var caseID string
	var revision int64
	if err := pool.QueryRow(ctx, `SELECT id, revision FROM recovery_cases WHERE org_id = $1 AND run_id = $2`,
		org, runID).Scan(&caseID, &revision); err != nil {
		t.Fatalf("read quarantine case: %v", err)
	}
	actor := &auth.Context{OrgID: org, UserID: "editor-1", Mode: auth.ModeDevHeaders, Source: auth.SourceWeb}
	diagnosed, err := eng.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: revision,
		Artifacts: []RecoveryArtifactInput{{Kind: "diagnosis", Payload: map[string]any{
			"mode": "deterministic_fallback", "summary": "semantic detector rejected source output",
		}}},
		Steps:       []RecoveryTransitionStep{{From: "contained", To: "diagnosed", Reason: "diagnosis recorded"}},
		AuditAction: audit.Action("recovery.case.diagnosed"),
	})
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	candidates, err := eng.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: diagnosed.Case.Revision,
		Artifacts: []RecoveryArtifactInput{{Kind: "candidate", Payload: SemanticRecoveryCandidatePayload{
			Kind: "replace_output", Decision: "replace", Output: map[string]any{"total": "10"},
			Reason: "restore the valid total", Risk: "medium",
			Evidence: []domain.RecoveryCaseEvidenceRef{
				{Kind: "run", ID: runID}, {Kind: "semantic_detector", ID: "det-total"},
			},
			ExpectedResult: "detectors pass", RequiredPermissions: []string{"recovery.write"},
		}}},
		Steps:       []RecoveryTransitionStep{{From: "diagnosed", To: "candidates_ready", Reason: "candidate recorded"}},
		AuditAction: audit.Action("recovery.case.candidates_created"),
	})
	if err != nil {
		t.Fatalf("candidate: %v", err)
	}
	candidate := candidates.Artifacts[0]
	validationPayload, err := eng.ValidateSemanticRecoveryCandidate(ctx, org, caseID, candidate.ID)
	if err != nil || !validationPayload.Passed {
		t.Fatalf("validate candidate: passed=%v err=%v", validationPayload.Passed, err)
	}
	validated, err := eng.AdvanceRecoveryCase(ctx, AdvanceRecoveryCaseInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: candidates.Case.Revision,
		Artifacts: []RecoveryArtifactInput{{Kind: "validation", Payload: validationPayload}},
		Steps: []RecoveryTransitionStep{
			{From: "candidates_ready", To: "validating", Reason: "validation started"},
			{From: "validating", To: "awaiting_approval", Reason: validationPayload.Summary},
		},
		AuditAction: audit.Action("recovery.case.validated"),
	})
	if err != nil {
		t.Fatalf("persist validation: %v", err)
	}
	validation := validated.Artifacts[0]
	if _, err := eng.ApproveRecoveryCandidate(ctx, ApproveRecoveryCandidateInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: validated.Case.Revision,
		CandidateArtifactID: candidate.ID, ValidationArtifactID: validation.ID,
	}); err != nil {
		t.Fatalf("approve: %v", err)
	}
	return runID, ResolveSemanticOutcomeInput{
		Auth: actor, CaseID: caseID, ExpectedRevision: validated.Case.Revision,
		CandidateArtifactID: candidate.ID, ValidationArtifactID: validation.ID,
	}
}
