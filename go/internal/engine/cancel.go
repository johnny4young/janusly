// Run cancellation, ported from the reference: the run flips to cancelled,
// every node still in a cancellable state (pending, queued, waiting) flips
// with it — running nodes finish naturally and the post-success guard
// absorbs their downstream scheduling — and one run.cancelled event records
// the operator's reason.
package engine

import (
	"context"
	"fmt"

	"github.com/johnny4young/janusly/go/internal/store"
)

// CancelRun commits the cancellation in one transaction under the run's
// completion lock. Terminal-status guarding belongs to the API layer, like
// the reference; the engine write itself is unconditional.
func (e *Engine) CancelRun(ctx context.Context, runID string, reason any) error {
	if reason == nil {
		reason = map[string]any{}
	}
	cancelledAt := eventNow()
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
	if err := q.CancelRun(ctx, runID); err != nil {
		return fmt.Errorf("cancel run: %w", err)
	}
	if _, err := q.CancelRunNodes(ctx, store.CancelRunNodesParams{
		RunID: runID, StateJson: stateJSON, FinishedAt: &cancelledAt,
	}); err != nil {
		return fmt.Errorf("cancel nodes: %w", err)
	}
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID, Type: "run.cancelled",
		Payload: eventJSON, CreatedAt: &cancelledAt,
	}); err != nil {
		return fmt.Errorf("insert run.cancelled: %w", err)
	}
	if err := q.NotifyRunEvents(ctx, runID); err != nil {
		return fmt.Errorf("notify run events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}
