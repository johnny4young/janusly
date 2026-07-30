// Node completion — the queue's producing side. One transaction commits the
// node's terminal transition, its timeline event, the readiness scan that
// queues downstream nodes, and (when nothing was queued) the run-level
// rollup. A per-run advisory xact lock serializes completion transactions,
// so a sibling branch finishing concurrently always sees this node's final
// status before deciding whether a join is ready: fan-in needs no separate
// reconciler because there is no crash window between "node done" and
// "successors queued".
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/store"
)

// ClaimedNode identifies one claimed queue delivery.
type ClaimedNode struct {
	RowID   string
	RunID   string
	NodeID  string
	Attempt int32
}

// CompleteNode commits a successful execution: node succeeded with its
// output, the node.succeeded event (output inlined only under the 8 KB
// threshold), ready successors queued with their node.queued events, and the
// run rolled up to a terminal status when no work remains. Returns without
// error when the CAS finds the node no longer running — another actor owns
// that transition.
func (e *Engine) CompleteNode(ctx context.Context, claim ClaimedNode, output any) error {
	if output == nil {
		output = map[string]any{}
	}
	outputJSON, err := json.Marshal(output)
	if err != nil {
		return fmt.Errorf("marshal output: %w", err)
	}
	stateJSON, err := json.Marshal(map[string]any{"output": output})
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	var eventPayload map[string]any
	if len(outputJSON) <= nodeSucceededOutputMaxBytes {
		eventPayload = map[string]any{"output": output, "attempt": claim.Attempt}
	} else {
		eventPayload = map[string]any{
			"outputBytes": len(outputJSON), "outputTruncated": true, "attempt": claim.Attempt,
		}
	}
	eventJSON, err := json.Marshal(eventPayload)
	if err != nil {
		return fmt.Errorf("marshal event payload: %w", err)
	}

	finishedAt := time.Now().UTC()
	return e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries) error {
		completed, err := q.CompleteRunNode(ctx, store.CompleteRunNodeParams{
			RunID: claim.RunID, NodeID: claim.NodeID,
			StateJson:  boundPayload(stateJSON, stateJSONMaxBytes),
			FinishedAt: &finishedAt,
		})
		if err != nil {
			return fmt.Errorf("complete node: %w", err)
		}
		if completed == 0 {
			return errSkipCommit
		}
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: claim.RunID,
			NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
			Type:   "node.succeeded", Payload: eventJSON, CreatedAt: &finishedAt,
		}); err != nil {
			return fmt.Errorf("insert node.succeeded: %w", err)
		}
		return e.scheduleDownstream(ctx, q, claim.RunID, finishedAt)
	})
}

// FailNode commits a terminal execution failure: node failed with its error,
// the node.failed event, and the run flipped to failed. Deliberately minimal
// ahead of the retry ladder and dead-letter capture, which extend this same
// transaction later.
func (e *Engine) FailNode(ctx context.Context, claim ClaimedNode, execErr error) error {
	errorJSON, err := json.Marshal(map[string]any{"message": execErr.Error()})
	if err != nil {
		return fmt.Errorf("marshal error: %w", err)
	}
	eventJSON, err := json.Marshal(map[string]any{
		"error": map[string]any{"message": execErr.Error()}, "attempt": claim.Attempt,
	})
	if err != nil {
		return fmt.Errorf("marshal event payload: %w", err)
	}

	failedAt := time.Now().UTC()
	return e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries) error {
		failed, err := q.FailRunNode(ctx, store.FailRunNodeParams{
			RunID: claim.RunID, NodeID: claim.NodeID,
			ErrorJson:  boundPayload(errorJSON, stateJSONMaxBytes),
			FinishedAt: &failedAt,
		})
		if err != nil {
			return fmt.Errorf("fail node: %w", err)
		}
		if failed == 0 {
			return errSkipCommit
		}
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: claim.RunID,
			NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
			Type:   "node.failed", Payload: eventJSON, CreatedAt: &failedAt,
		}); err != nil {
			return fmt.Errorf("insert node.failed: %w", err)
		}

		statuses, err := e.nodeStatuses(ctx, q, claim.RunID)
		if err != nil {
			return err
		}
		failedNodes := 0
		for _, status := range statuses {
			if status == "failed" {
				failedNodes++
			}
		}
		return e.flipRunTerminal(ctx, q, claim.RunID, "failed",
			map[string]any{"failedNodes": failedNodes}, failedAt)
	})
}

// errSkipCommit aborts the transaction without reporting an error to the
// caller: the CAS lost, so another actor owns the node's terminal state.
var errSkipCommit = fmt.Errorf("skip commit: node transition lost the compare-and-set")

// inCompletionTx runs handler inside one transaction that holds the per-run
// completion lock. The lock releases on commit, which is what guarantees a
// concurrent sibling's readiness scan reads this transaction's writes.
func (e *Engine) inCompletionTx(ctx context.Context, runID string, handler func(q *store.Queries) error) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	if err := q.AcquireRunCompletionLock(ctx, runID); err != nil {
		return fmt.Errorf("acquire completion lock: %w", err)
	}
	if err := handler(q); err != nil {
		if err == errSkipCommit {
			return nil
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// scheduleDownstream queues every ready successor (emitting node.queued per
// claim) and wakes the workers; when nothing was queued it rolls the run up
// to succeeded/failed if no open work remains.
func (e *Engine) scheduleDownstream(ctx context.Context, q *store.Queries, runID string, completedAt time.Time) error {
	run, err := q.GetRunExecution(ctx, runID)
	if err != nil {
		return fmt.Errorf("read run: %w", err)
	}
	if run.Status != "running" {
		// Cancellation (or a concurrent failure) landed while this node ran:
		// its own terminal state stays, but no downstream work is scheduled
		// for a run the operator already stopped.
		return nil
	}
	wf, err := workflowFromRunInput(run.InputJson)
	if err != nil {
		return err
	}
	statuses, err := e.nodeStatuses(ctx, q, runID)
	if err != nil {
		return err
	}

	queued := 0
	for _, nodeID := range readySuccessors(wf, statuses) {
		rows, err := q.QueueRunNode(ctx, store.QueueRunNodeParams{RunID: runID, NodeID: nodeID})
		if err != nil {
			return fmt.Errorf("queue node %s: %w", nodeID, err)
		}
		if rows == 0 {
			continue
		}
		queued++
		queuedAt := time.Now().UTC()
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: runID,
			NodeID: pgtype.Text{String: nodeID, Valid: true},
			Type:   "node.queued", Payload: json.RawMessage(`{}`),
			CreatedAt: &queuedAt,
		}); err != nil {
			return fmt.Errorf("insert node.queued: %w", err)
		}
	}

	if queued > 0 {
		if err := q.NotifyWake(ctx, runID); err != nil {
			return fmt.Errorf("notify wake: %w", err)
		}
		return nil
	}

	anyFailed, anyOpen := false, false
	total := 0
	for _, status := range statuses {
		total++
		if status == "failed" {
			anyFailed = true
		}
		if openNodeStatuses[status] {
			anyOpen = true
		}
	}
	if anyFailed {
		failedNodes := 0
		for _, status := range statuses {
			if status == "failed" {
				failedNodes++
			}
		}
		return e.flipRunTerminal(ctx, q, runID, "failed",
			map[string]any{"failedNodes": failedNodes}, completedAt)
	}
	if total > 0 && !anyOpen {
		return e.flipRunTerminal(ctx, q, runID, "succeeded",
			map[string]any{"nodes": total}, completedAt)
	}
	return nil
}

// flipRunTerminal transitions the run out of running and, only when this
// call performed the transition, appends the run-level event. Its timestamp
// sits 1 ms after the causal node event so the (created_at, id) keyset never
// orders the aggregate consequence before its cause.
func (e *Engine) flipRunTerminal(ctx context.Context, q *store.Queries, runID, status string, payload map[string]any, causeAt time.Time) error {
	flipped, err := q.MarkRunTerminalFromRunning(ctx, store.MarkRunTerminalFromRunningParams{
		ID: runID, Status: status,
	})
	if err != nil {
		return fmt.Errorf("flip run %s: %w", status, err)
	}
	if flipped == 0 {
		return nil
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal run event payload: %w", err)
	}
	eventAt := causeAt.Add(time.Millisecond)
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: e.newID(), RunID: runID, Type: "run." + status,
		Payload: payloadJSON, CreatedAt: &eventAt,
	}); err != nil {
		return fmt.Errorf("insert run.%s: %w", status, err)
	}
	return nil
}

func (e *Engine) nodeStatuses(ctx context.Context, q *store.Queries, runID string) (map[string]string, error) {
	rows, err := q.ListRunNodeStatuses(ctx, runID)
	if err != nil {
		return nil, fmt.Errorf("read node statuses: %w", err)
	}
	statuses := make(map[string]string, len(rows))
	for _, row := range rows {
		statuses[row.NodeID] = row.Status
	}
	return statuses, nil
}

// workflowFromRunInput recovers the workflow snapshot persisted at run
// start; the snapshot round-trips the contract, so parse issues here mean a
// corrupted row rather than operator input.
func workflowFromRunInput(inputJSON []byte) (*domain.Workflow, error) {
	var envelope struct {
		Workflow json.RawMessage `json:"workflow"`
	}
	if err := json.Unmarshal(inputJSON, &envelope); err != nil {
		return nil, fmt.Errorf("decode run input: %w", err)
	}
	wf, issues := domain.Parse(envelope.Workflow)
	if wf == nil {
		return nil, fmt.Errorf("run workflow snapshot invalid: %+v", issues)
	}
	return wf, nil
}
