// The waiting lifecycle: a node pauses (approval, wait_until), the run stays
// running, and resumption — human or timer — completes the still-waiting
// node with the compare-and-set the whole engine relies on, so a duplicate
// resume can never double-write output or double-queue downstream work.
package engine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/store"
)

// ErrResumeConflict reports a resume against a node that is not waiting —
// the API maps it to 409, matching the reference's ResumeRunConflictError.
var ErrResumeConflict = errors.New("Node is not waiting") //nolint:staticcheck // reference message is the wire contract

// ErrResumeNodeNotFound reports a resume naming a node outside the run's
// workflow snapshot.
var ErrResumeNodeNotFound = errors.New("Node not found") //nolint:staticcheck // reference message is the wire contract

// MarkNodeWaiting commits the pause checkpoint: node running→waiting with
// {waiting: {reason, ...metadata, waitingSince}} state, the node.waiting
// event, and — for timers — the wake-up that auto-resumes it.
func (e *Engine) MarkNodeWaiting(ctx context.Context, claim ClaimedNode, waiting executors.Waiting) error {
	checkpointAt := time.Now().UTC()
	metadata := map[string]any{}
	if waiting.Reason != "" {
		metadata["reason"] = waiting.Reason
	}
	for key, value := range waiting.Metadata {
		metadata[key] = value
	}
	metadata["waitingSince"] = checkpointAt.Format("2006-01-02T15:04:05.000Z")
	stateJSON := safePersist(map[string]any{"waiting": metadata}, stateJSONMaxBytes)
	eventJSON := safePersist(map[string]any{
		"status": "waiting", "reason": waiting.Reason, "metadata": metadata,
	}, defaultPersistMaxBytes)

	return e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries) error {
		marked, err := q.MarkRunNodeWaiting(ctx, store.MarkRunNodeWaitingParams{
			RunID: claim.RunID, NodeID: claim.NodeID, StateJson: stateJSON,
		})
		if err != nil {
			return fmt.Errorf("mark waiting: %w", err)
		}
		if marked == 0 {
			return errSkipCommit
		}
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: claim.RunID,
			NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
			Type:   "node.waiting", Payload: eventJSON, CreatedAt: &checkpointAt,
		}); err != nil {
			return fmt.Errorf("insert node.waiting: %w", err)
		}
		if waiting.WakeAt != nil {
			if err := q.UpsertWakeup(ctx, store.UpsertWakeupParams{
				RunNodeID: claim.RowID, WakeAt: waiting.WakeAt.UTC(), Reason: "wait_until",
			}); err != nil {
				return fmt.Errorf("schedule wait wakeup: %w", err)
			}
		}
		return nil
	})
}

// ResumeRun completes one still-waiting node and queues its downstream
// work, all in one transaction. Approval and wait_until keep the
// reference's historical empty output — the decision lives in the run
// timeline, never in the node output.
func (e *Engine) ResumeRun(ctx context.Context, runID, nodeID string) error {
	finishedAt := time.Now().UTC()
	return e.inCompletionTx(ctx, runID, func(q *store.Queries) error {
		run, err := q.GetRunExecution(ctx, runID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("Run not found") //nolint:staticcheck // reference message is the wire contract
			}
			return fmt.Errorf("read run: %w", err)
		}
		wf, _, err := workflowFromRunInput(run.InputJson)
		if err != nil {
			return err
		}
		found := false
		for _, node := range wf.Nodes {
			if node.ID == nodeID {
				found = true
				break
			}
		}
		if !found {
			return ErrResumeNodeNotFound
		}

		rowID, err := q.MarkWaitingNodeSucceeded(ctx, store.MarkWaitingNodeSucceededParams{
			RunID: runID, NodeID: nodeID,
			StateJson:  safePersist(map[string]any{"output": map[string]any{}}, stateJSONMaxBytes),
			FinishedAt: &finishedAt,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrResumeConflict
			}
			return fmt.Errorf("complete waiting node: %w", err)
		}
		if err := q.DeleteWakeup(ctx, rowID); err != nil {
			return fmt.Errorf("clear wakeup: %w", err)
		}
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: runID,
			NodeID: pgtype.Text{String: nodeID, Valid: true},
			Type:   "node.resumed", Payload: []byte(`{}`), CreatedAt: &finishedAt,
		}); err != nil {
			return fmt.Errorf("insert node.resumed: %w", err)
		}
		return e.scheduleDownstream(ctx, q, runID, finishedAt)
	})
}

// resumeDueTimers auto-completes every waiting node whose wake-up clock has
// passed — the wait_until firing path. A conflict means another actor
// (manual resume, cancellation) advanced the node first; that is the
// idempotency contract, not an error.
func (e *Engine) resumeDueTimers(ctx context.Context, q *store.Queries) int {
	due, err := q.ListDueWaitingWakeups(ctx, 50)
	if err != nil {
		return 0
	}
	resumed := 0
	for _, timer := range due {
		err := e.ResumeRun(ctx, timer.RunID, timer.NodeID)
		if err == nil {
			resumed++
			continue
		}
		if !errors.Is(err, ErrResumeConflict) && ctx.Err() == nil {
			// Leave the wake-up in place; the next sweep retries.
			continue
		}
	}
	return resumed
}
