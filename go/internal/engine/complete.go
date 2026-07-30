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
	"github.com/johnny4young/janusly/go/internal/grammar"
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
			map[string]any{"failedNodes": failedNodes}, failedAt, nil)
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

// scheduleDownstream runs the readiness scan: queue every ready successor
// (emitting node.queued), skip nodes whose satisfied incoming edges all
// carry false conditions (a skipped predecessor satisfies its edges, so a
// join fed by the losing branch still unblocks), and — when nothing was
// queued — roll the run up to a terminal status, projecting declared
// outputs on success. The scan loops to a fixpoint so an in-scan skip can
// enable nodes regardless of declaration order.
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
	wf, runInput, err := workflowFromRunInput(run.InputJson)
	if err != nil {
		return err
	}

	// Cheap path: statuses alone unless some edge condition can reach into
	// outputs, or declared outputs will need the full context at terminal.
	needFull := len(wf.Outputs) > 0
	for _, edge := range wf.Edges {
		if edge.Condition != "" {
			needFull = true
			break
		}
	}
	statuses := map[string]string{}
	var runContext map[string]any
	if needFull {
		rows, err := q.ListRunNodesByRun(ctx, runID)
		if err != nil {
			return fmt.Errorf("read node rows: %w", err)
		}
		runContext = runContextFromRows(rows)
		for nodeID, entry := range runContext {
			statuses[nodeID] = entry.(map[string]any)["status"].(string)
		}
	} else {
		statuses, err = e.nodeStatuses(ctx, q, runID)
		if err != nil {
			return err
		}
	}

	queued := 0
	for changed := true; changed; {
		changed = false
		for _, node := range wf.Nodes {
			if statuses[node.ID] != "pending" || !depsSatisfied(wf, node.ID, statuses) {
				continue
			}
			if !edgeAllowsRun(wf, node.ID, runContext) {
				skippedAt := time.Now().UTC()
				stateJSON, _ := json.Marshal(map[string]any{"skipped": map[string]any{"reason": "Condition not met"}})
				rows, err := q.SkipRunNode(ctx, store.SkipRunNodeParams{
					RunID: runID, NodeID: node.ID,
					StateJson: stateJSON, FinishedAt: &skippedAt,
				})
				if err != nil {
					return fmt.Errorf("skip node %s: %w", node.ID, err)
				}
				if rows > 0 {
					payload, _ := json.Marshal(map[string]any{"reason": "Condition not met"})
					if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
						ID: e.newID(), RunID: runID,
						NodeID: pgtype.Text{String: node.ID, Valid: true},
						Type:   "node.skipped", Payload: payload, CreatedAt: &skippedAt,
					}); err != nil {
						return fmt.Errorf("insert node.skipped: %w", err)
					}
				}
				statuses[node.ID] = "skipped"
				if runContext != nil {
					runContext[node.ID] = map[string]any{
						"status": "skipped", "attempts": float64(0),
						"state":  map[string]any{"skipped": map[string]any{"reason": "Condition not met"}},
						"output": map[string]any{}, "error": nil,
					}
				}
				changed = true
				continue
			}
			rows, err := q.QueueRunNode(ctx, store.QueueRunNodeParams{RunID: runID, NodeID: node.ID})
			if err != nil {
				return fmt.Errorf("queue node %s: %w", node.ID, err)
			}
			if rows == 0 {
				continue
			}
			queued++
			changed = true
			statuses[node.ID] = "queued"
			queuedAt := time.Now().UTC()
			if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
				ID: e.newID(), RunID: runID,
				NodeID: pgtype.Text{String: node.ID, Valid: true},
				Type:   "node.queued", Payload: json.RawMessage(`{}`),
				CreatedAt: &queuedAt,
			}); err != nil {
				return fmt.Errorf("insert node.queued: %w", err)
			}
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
	failedNodes := 0
	for _, status := range statuses {
		total++
		if status == "failed" {
			anyFailed = true
			failedNodes++
		}
		if openNodeStatuses[status] {
			anyOpen = true
		}
	}
	if anyFailed {
		return e.flipRunTerminal(ctx, q, runID, "failed",
			map[string]any{"failedNodes": failedNodes}, completedAt, nil)
	}
	if total > 0 && !anyOpen {
		var outputJSON json.RawMessage
		if len(wf.Outputs) > 0 {
			outputJSON, _ = json.Marshal(projectOutputs(wf.Outputs, runContext, runInput))
		}
		return e.flipRunTerminal(ctx, q, runID, "succeeded",
			map[string]any{"nodes": total}, completedAt, outputJSON)
	}
	return nil
}

// edgeAllowsRun decides whether a ready pending node should run: roots are
// unconditional, any incoming edge without a condition allows the run, and
// otherwise any truthy condition does. An evaluation error reads as false —
// the authoring validator rejects out-of-grammar conditions at save, so a
// runtime error can only mean data-driven drift, and a deterministic skip
// beats a stuck run.
func edgeAllowsRun(wf *domain.Workflow, nodeID string, runContext map[string]any) bool {
	incoming := 0
	for _, edge := range wf.Edges {
		if edge.To != nodeID {
			continue
		}
		incoming++
		if edge.Condition == "" {
			return true
		}
		result, err := grammar.EvaluateExpression(edge.Condition, grammar.Scope{
			Context: runContext, Inputs: map[string]any{},
		})
		if err == nil && result {
			return true
		}
	}
	return incoming == 0
}

// flipRunTerminal transitions the run out of running and, only when this
// call performed the transition, appends the run-level event. Its timestamp
// sits 1 ms after the causal node event so the (created_at, id) keyset never
// orders the aggregate consequence before its cause.
func (e *Engine) flipRunTerminal(ctx context.Context, q *store.Queries, runID, status string, payload map[string]any, causeAt time.Time, outputJSON json.RawMessage) error {
	flipped, err := q.MarkRunTerminalFromRunning(ctx, store.MarkRunTerminalFromRunningParams{
		ID: runID, Status: status, OutputJson: outputJSON,
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

// workflowFromRunInput recovers the workflow snapshot and resolved input
// persisted at run start; the snapshot round-trips the contract, so parse
// issues here mean a corrupted row rather than operator input.
func workflowFromRunInput(inputJSON []byte) (*domain.Workflow, map[string]any, error) {
	var envelope struct {
		Workflow json.RawMessage `json:"workflow"`
		Input    map[string]any  `json:"input"`
	}
	if err := json.Unmarshal(inputJSON, &envelope); err != nil {
		return nil, nil, fmt.Errorf("decode run input: %w", err)
	}
	wf, issues := domain.Parse(envelope.Workflow)
	if wf == nil {
		return nil, nil, fmt.Errorf("run workflow snapshot invalid: %+v", issues)
	}
	return wf, envelope.Input, nil
}
