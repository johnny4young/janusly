// Downstream scheduling + run settle (T-526 split): the readiness scan
// with the atomic queue claim, edge-condition gating, terminal run flip
// (cause+1ms ordering) and the status_checked settle marker. The pure
// readiness predicates live in readiness.go.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"


	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/store"
)

func (e *Engine) scheduleDownstream(ctx context.Context, q *store.Queries, events *runEventBuffer, runID string, completedAt time.Time) error {
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
				skippedAt := eventNow()
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
					events.add(e.newID(), runID, node.ID, "node.skipped", payload, skippedAt)
				}
				metricNodeCompletions.WithLabelValues("skipped").Inc()
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
			queuedAt := eventNow()
			events.add(e.newID(), runID, node.ID, "node.queued", json.RawMessage(`{}`), queuedAt)
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
		if err := e.flipRunTerminal(ctx, q, events, runID, "failed",
			map[string]any{"failedNodes": failedNodes}, completedAt, nil); err != nil {
			return err
		}
		return e.appendStatusChecked(ctx, events, runID, completedAt)
	}
	if total > 0 && !anyOpen {
		var outputJSON json.RawMessage
		if len(wf.Outputs) > 0 {
			outputJSON, _ = json.Marshal(projectOutputs(wf.Outputs, runContext, runInput))
		}
		if err := e.flipRunTerminal(ctx, q, events, runID, "succeeded",
			map[string]any{"nodes": total}, completedAt, outputJSON); err != nil {
			return err
		}
		return e.appendStatusChecked(ctx, events, runID, completedAt)
	}
	return e.appendStatusChecked(ctx, events, runID, completedAt)
}

// appendStatusChecked is the reference's fan-in settle marker: every
// enqueue pass that queued NOTHING re-derived the run status and says so
// (runtime.ts). +2ms so it always sorts after the terminal run event
// (which sits at cause+1ms).
func (e *Engine) appendStatusChecked(ctx context.Context, events *runEventBuffer, runID string, causeAt time.Time) error {
	checkedAt := causeAt.Add(2 * time.Millisecond)
	events.add(e.newID(), runID, "", "run.status_checked", json.RawMessage(`{}`), checkedAt)
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
func (e *Engine) flipRunTerminal(ctx context.Context, q *store.Queries, events *runEventBuffer, runID, status string, payload map[string]any, causeAt time.Time, outputJSON json.RawMessage) error {
	flipped, err := q.MarkRunTerminalFromRunning(ctx, store.MarkRunTerminalFromRunningParams{
		ID: runID, Status: status, OutputJson: outputJSON,
	})
	if err != nil {
		return fmt.Errorf("flip run %s: %w", status, err)
	}
	if flipped == 0 {
		return nil
	}
	metricRunsTerminal.WithLabelValues(status).Inc()
	// A validation run carrying a playbook claim reports its outcome here:
	// success refreshes evidence, failure auto-retires (in the same tx as
	// the terminal flip, so evidence and outcome can't drift).
	e.recordPlaybookValidationOutcome(ctx, q, runID, status)
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal run event payload: %w", err)
	}
	eventAt := causeAt.Add(time.Millisecond)
	events.add(e.newID(), runID, "", "run."+status, payloadJSON, eventAt)
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
