// Dead-letter redrive: the operator's second chance. Claiming the row is a
// compare-and-set on replay_claimed_at — the exact-identity guard the
// reference uses — so one dead letter authorizes exactly one revival. The
// failed node requeues with its attempt advanced, the run revives, and the
// ordinary claim loop takes it from there.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

// ErrDeadLetterNotFound covers both a missing id and a cross-org read —
// indistinguishable by design, the API maps it to 404.
var ErrDeadLetterNotFound = errors.New("dead letter not found")

// ErrRedriveConflict reports a dead letter whose replay is already claimed,
// or a node no longer in the failed state; the API maps it to 409.
var ErrRedriveConflict = errors.New("dead letter replay already claimed")

// RedriveOptions carries the optional extras a redrive can stamp on the
// revival: a VERIFIED playbook claim, an applied fix (replaces the run's
// workflow snapshot so the revived node executes the patch), and a
// cluster-signature override for the ownership incident.
type RedriveOptions struct {
	PlaybookID        string
	ValidationRunID   string
	FixWorkflowJSON   []byte
	SignatureOverride string
	// RequestedBy attributes the eventual terminal-impact win to the
	// operator who initiated the replay (the reference's recoveryActorId).
	RequestedBy string
}

// RedriveDeadLetter revives the run behind one dead letter: claim the row,
// requeue the failed node with attempt+1, flip the run back to running and
// wake the workers — one transaction, so a crash can never leave a claimed
// dead letter without its revived node.
func (e *Engine) RedriveDeadLetter(ctx context.Context, orgID, deadLetterID string) error {
	return e.RedriveDeadLetterWithOptions(ctx, orgID, deadLetterID, RedriveOptions{})
}

// RedriveDeadLetterWithPlaybook additionally stamps a VERIFIED playbook
// claim on the revived node, so the terminal impact tail can credit the
// playbook's applied win atomically.
func (e *Engine) RedriveDeadLetterWithPlaybook(ctx context.Context, orgID, deadLetterID, playbookID, validationRunID string) error {
	return e.RedriveDeadLetterWithOptions(ctx, orgID, deadLetterID, RedriveOptions{
		PlaybookID: playbookID, ValidationRunID: validationRunID,
	})
}

// RedriveDeadLetterWithOptions is the full form (cluster-apply + applied
// fixes ride here).
func (e *Engine) RedriveDeadLetterWithOptions(ctx context.Context, orgID, deadLetterID string, opts RedriveOptions) error {
	playbookID, validationRunID := opts.PlaybookID, opts.ValidationRunID
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))

	deadLetter, err := q.GetDeadLetter(ctx, store.GetDeadLetterParams{ID: deadLetterID, OrgID: orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrDeadLetterNotFound
		}
		return fmt.Errorf("read dead letter: %w", err)
	}
	// Same per-run serialization as every completion transaction, so the
	// revival can't interleave with a concurrent scan of the same run.
	if err := q.AcquireRunCompletionLock(ctx, deadLetter.RunID); err != nil {
		return fmt.Errorf("acquire completion lock: %w", err)
	}
	claimed, err := q.ClaimDeadLetterReplay(ctx, store.ClaimDeadLetterReplayParams{
		ID: deadLetterID, OrgID: orgID,
	})
	if err != nil {
		return fmt.Errorf("claim replay: %w", err)
	}
	if claimed == 0 {
		return ErrRedriveConflict
	}
	attempt, err := q.RedriveFailedRunNode(ctx, store.RedriveFailedRunNodeParams{
		RunID: deadLetter.RunID, NodeID: deadLetter.NodeID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The node moved past failed (an earlier redrive, a cancel):
			// nothing to revive, and the claim must not burn.
			return ErrRedriveConflict
		}
		return fmt.Errorf("requeue failed node: %w", err)
	}
	// The GENERATION-BOUND claim: a fresh token per replay binds this exact
	// revival to its future terminal success — an old claim can never
	// credit a different execution, and initiation alone credits nothing.
	if err := q.StampRedriveRecoveryClaim(ctx, store.StampRedriveRecoveryClaimParams{
		RunID: deadLetter.RunID, NodeID: deadLetter.NodeID,
		RecoveryDeadLetterID:    pgtype.Text{String: deadLetterID, Valid: true},
		RecoveryRequestedBy:     pgtype.Text{String: opts.RequestedBy, Valid: opts.RequestedBy != ""},
		RecoveryClaimToken:      pgtype.Text{String: e.newID(), Valid: true},
		RecoveryPlaybookID:      pgtype.Text{String: playbookID, Valid: playbookID != ""},
		RecoveryValidationRunID: pgtype.Text{String: validationRunID, Valid: validationRunID != ""},
	}); err != nil {
		return fmt.Errorf("stamp recovery claim: %w", err)
	}
	// An applied fix replaces the run's workflow snapshot INSIDE the same
	// transaction, so the revived node executes the patch and the run's
	// recorded configuration reflects what actually ran (the reference
	// replays the patched snapshot; the pilot's revive-in-place equivalent
	// is the snapshot swap).
	if len(opts.FixWorkflowJSON) > 0 {
		if err := q.UpdateRunWorkflowSnapshot(ctx, store.UpdateRunWorkflowSnapshotParams{
			ID: deadLetter.RunID, Workflow: opts.FixWorkflowJSON,
		}); err != nil {
			return fmt.Errorf("apply fix snapshot: %w", err)
		}
	}
	if _, err := q.ReviveFailedRun(ctx, deadLetter.RunID); err != nil {
		return fmt.Errorf("revive run: %w", err)
	}
	// The ownership incident opens WITH the replay (idempotent on the
	// unique (org, dead_letter)): severity default p3, SLA 24h, the error
	// signature for clustering. Resolution happens ONLY at terminal
	// success (recordRecoveryImpact) — initiation opens work, never wins.
	signature := opts.SignatureOverride
	if signature == "" {
		// The NORMALIZED signature (same normalizer as /dlq/clusters), so
		// item-level recurrence matching lines up with cluster signatures.
		signature = DeadLetterSignature(deadLetter)
	}
	workflowID := ""
	var wfDoc struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(deadLetter.WorkflowJson, &wfDoc)
	workflowID = wfDoc.ID
	slaTarget := eventNow().Add(24 * time.Hour)
	if _, err := q.InsertRecoveryItem(ctx, store.InsertRecoveryItemParams{
		ID: e.newID(), OrgID: orgID, DeadLetterID: deadLetterID,
		WorkflowID:     pgtype.Text{String: workflowID, Valid: workflowID != ""},
		Severity:       "p3",
		SlaTargetAt:    slaTarget,
		ErrorSignature: pgtype.Text{String: signature, Valid: signature != ""},
		CreatedBy:      pgtype.Text{},
	}); err != nil {
		return fmt.Errorf("insert recovery item: %w", err)
	}

	redrivenAt := eventNow()
	payload, err := json.Marshal(map[string]any{
		"deadLetterId": deadLetterID, "attempt": attempt,
	})
	if err != nil {
		return fmt.Errorf("marshal redrive payload: %w", err)
	}
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: deadLetter.RunID,
		NodeID: pgtype.Text{String: deadLetter.NodeID, Valid: true},
		Type:   "node.redriven", Payload: payload, CreatedAt: &redrivenAt,
	}); err != nil {
		return fmt.Errorf("insert node.redriven: %w", err)
	}
	if err := q.NotifyWake(ctx, deadLetter.RunID); err != nil {
		return fmt.Errorf("notify wake: %w", err)
	}
	if err := q.NotifyRunEvents(ctx, deadLetter.RunID); err != nil {
		return fmt.Errorf("notify run events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	metricRedrives.Inc()
	// Alert producer (post-commit): the ownership incident just opened.
	e.DispatchAlert(ctx, orgID, "recovery_item.created", map[string]any{
		"deadLetterId": deadLetterID, "workflowId": workflowID,
		"severity": "p3", "errorSignature": signature,
		"dedupeKey": "item:" + deadLetterID,
	})
	return nil
}

// RedriveRunNode is the exact-identity replay branch: the web's run
// panel posts {runId, nodeId} without a dead-letter id. Same in-place
// revival (attempt re-armed to 1) minus the dead-letter claim — the
// reference's second /dlq/replay branch.
func (e *Engine) RedriveRunNode(ctx context.Context, orgID, runID, nodeID string) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))

	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrDeadLetterNotFound
		}
		return fmt.Errorf("read run: %w", err)
	}
	_ = run
	if err := q.AcquireRunCompletionLock(ctx, runID); err != nil {
		return fmt.Errorf("acquire completion lock: %w", err)
	}
	attempt, err := q.RedriveFailedRunNode(ctx, store.RedriveFailedRunNodeParams{
		RunID: runID, NodeID: nodeID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRedriveConflict
		}
		return fmt.Errorf("requeue failed node: %w", err)
	}
	if _, err := q.ReviveFailedRun(ctx, runID); err != nil {
		return fmt.Errorf("revive run: %w", err)
	}
	redrivenAt := eventNow()
	payload, err := json.Marshal(map[string]any{"attempt": attempt})
	if err != nil {
		return fmt.Errorf("marshal redrive payload: %w", err)
	}
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID,
		NodeID: pgtype.Text{String: nodeID, Valid: true},
		Type:   "node.redriven", Payload: payload, CreatedAt: &redrivenAt,
	}); err != nil {
		return fmt.Errorf("insert node.redriven: %w", err)
	}
	if err := q.NotifyWake(ctx, runID); err != nil {
		return fmt.Errorf("notify wake: %w", err)
	}
	if err := q.NotifyRunEvents(ctx, runID); err != nil {
		return fmt.Errorf("notify run events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	metricRedrives.Inc()
	return nil
}
