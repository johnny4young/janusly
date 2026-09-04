// Run cancellation, implements the contract: the run flips to cancelled,
// every node still in a cancellable state (pending, queued, waiting) flips
// with it — running nodes finish naturally and the post-success guard
// absorbs their downstream scheduling — and one run.cancelled event records
// the operator's reason.
package engine

import (
	"context"
	"errors"
	"fmt"

	"github.com/johnny4young/janusly/internal/store"
)

// ErrRunAlreadyTerminal reports a cancel that lost the race against a
// terminal completion: the run reached succeeded/failed/timed_out (or was
// already cancelled) before the cancellation write.
var ErrRunAlreadyTerminal = errors.New("run is already terminal")

// CancelRun commits the cancellation in one transaction under the run's
// completion lock. The write itself is a CAS: the API's status pre-read
// happens outside this lock, so a completion can commit in between —
// losing that race must never regress a terminal run to cancelled.
func (e *Engine) CancelRun(ctx context.Context, runID string, reason any) error {
	if reason == nil {
		reason = map[string]any{}
	}
	cancelledAt := e.eventNow()
	stateJSON := safePersist(map[string]any{"cancelled": reason}, stateJSONMaxBytes)
	eventJSON := safePersist(reason, defaultPersistMaxBytes())

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	if err := q.AcquireRunCompletionLock(ctx, runID); err != nil {
		return fmt.Errorf("acquire completion lock: %w", err)
	}
	cancelled, err := q.CancelRun(ctx, runID)
	if err != nil {
		return fmt.Errorf("cancel run: %w", err)
	}
	if cancelled == 0 {
		return ErrRunAlreadyTerminal
	}
	if _, err := q.CancelRunNodes(ctx, store.CancelRunNodesParams{
		RunID: runID, StateJson: stateJSON, FinishedAt: &cancelledAt,
	}); err != nil {
		return fmt.Errorf("cancel nodes: %w", err)
	}
	terminalEventID := e.newID()
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: terminalEventID, RunID: runID, Type: "run.cancelled",
		Payload: eventJSON, CreatedAt: &cancelledAt,
	}); err != nil {
		return fmt.Errorf("insert run.cancelled: %w", err)
	}
	if err := e.finalizeSemanticRecoveryMonitoring(
		ctx, q, runID, "cancelled", terminalEventID, cancelledAt,
	); err != nil {
		return fmt.Errorf("finalize cancelled semantic recovery monitoring: %w", err)
	}
	if err := q.NotifyRunEvents(ctx, runID); err != nil {
		return fmt.Errorf("notify run events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	// A cancelled subworkflow child settles its waiting parent the same
	// way any terminal child does; the reconciler is the durable backstop.
	e.DeliverParentNotifications(ctx, runID)
	return nil
}
