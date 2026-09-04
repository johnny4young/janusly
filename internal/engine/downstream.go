// Downstream scheduling + run settle: the readiness scan
// with the atomic queue claim, edge-condition gating, terminal run flip
// (cause+1ms ordering) and the status_checked settle marker. The pure
// readiness predicates live in readiness.go.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
)

// Constant skip payloads: these used to be re-serialized on every pass of
// the fixed-point readiness loop, once per node, for a value that never
// changes. Hoisting also collapses three copies of the same literal
// reason string into one place.
var (
	skippedEdgeState   = json.RawMessage(`{"skipped":{"reason":"Condition not met"}}`)
	skippedEdgePayload = json.RawMessage(`{"reason":"Condition not met"}`)
	// A doomed node sits behind an edge that can no longer fire: an
	// on-error edge whose source succeeded, or a normal edge whose
	// source failed with the failure handled elsewhere.
	skippedBranchState   = json.RawMessage(`{"skipped":{"reason":"Branch not taken"}}`)
	skippedBranchPayload = json.RawMessage(`{"reason":"Branch not taken"}`)
)

func (e *Engine) scheduleDownstream(ctx context.Context, q *store.Queries, events *runEventBuffer, claim ClaimedNode, completedAt time.Time) (terminal bool, err error) {
	runID := claim.RunID
	// The status is re-read on this transaction's snapshot (cancellation
	// may have landed while the node ran), but the workflow rides the
	// claim: a completion no longer transfers or re-parses input_json.
	header, err := q.GetRunHeader(ctx, runID)
	if err != nil {
		return false, fmt.Errorf("read run: %w", err)
	}
	if header.Status != "running" {
		// Cancellation (or a concurrent failure) landed while this node ran:
		// its own terminal state stays, but no downstream work is scheduled
		// for a run the operator already stopped.
		return false, nil
	}
	wf, runInput, err := e.runWorkflow(ctx, q, claim)
	if err != nil {
		return false, err
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
			return false, fmt.Errorf("read node rows: %w", err)
		}
		runContext = runContextFromRows(rows)
		for nodeID, entry := range runContext {
			statuses[nodeID] = entry.(map[string]any)["status"].(string)
		}
	} else {
		statuses, err = e.nodeStatuses(ctx, q, runID)
		if err != nil {
			return false, err
		}
	}

	queued := 0
	for changed := true; changed; {
		changed = false
		for _, node := range wf.Nodes {
			if statuses[node.ID] != "pending" {
				continue
			}
			doomed := depsDoomed(wf, node.ID, statuses)
			if !doomed && !depsSatisfied(wf, node.ID, statuses) {
				continue
			}
			if doomed || !edgeAllowsRun(wf, node.ID, runContext) {
				skippedAt := e.eventNow()
				stateJSON, payload, reason := skippedEdgeState, skippedEdgePayload, "Condition not met"
				if doomed {
					stateJSON, payload, reason = skippedBranchState, skippedBranchPayload, "Branch not taken"
				}
				rows, err := q.SkipRunNode(ctx, store.SkipRunNodeParams{
					RunID: runID, NodeID: node.ID,
					StateJson: stateJSON, FinishedAt: &skippedAt,
				})
				if err != nil {
					return false, fmt.Errorf("skip node %s: %w", node.ID, err)
				}
				if rows > 0 {
					events.add(e.newID(), runID, node.ID, "node.skipped", payload, skippedAt)
				}
				metricNodeCompletions.WithLabelValues("skipped").Inc()
				statuses[node.ID] = "skipped"
				if runContext != nil {
					runContext[node.ID] = map[string]any{
						"status": "skipped", "attempts": float64(0),
						"state":  map[string]any{"skipped": map[string]any{"reason": reason}},
						"output": map[string]any{}, "error": nil,
					}
				}
				changed = true
				continue
			}
			rows, err := q.QueueRunNode(ctx, store.QueueRunNodeParams{RunID: runID, NodeID: node.ID})
			if err != nil {
				return false, fmt.Errorf("queue node %s: %w", node.ID, err)
			}
			if rows == 0 {
				continue
			}
			queued++
			changed = true
			statuses[node.ID] = "queued"
			queuedAt := e.eventNow()
			events.add(e.newID(), runID, node.ID, "node.queued", json.RawMessage(`{}`), queuedAt)
		}
	}

	if queued > 0 {
		if err := q.NotifyWake(ctx, runID); err != nil {
			return false, fmt.Errorf("notify wake: %w", err)
		}
		return false, nil
	}

	anyUnhandledFailed, anyOpen := false, false
	total := 0
	failedNodes, handledFailures := 0, 0
	for nodeID, status := range statuses {
		total++
		if status == "failed" {
			failedNodes++
			if nodeFailureHandled(wf, nodeID) {
				handledFailures++
			} else {
				anyUnhandledFailed = true
			}
		}
		if openNodeStatuses[status] {
			anyOpen = true
		}
	}
	if anyUnhandledFailed {
		if err := e.flipRunTerminal(ctx, q, events, runID, "failed",
			map[string]any{"failedNodes": failedNodes}, completedAt, nil); err != nil {
			return false, err
		}
		return true, e.appendStatusChecked(ctx, events, runID, completedAt)
	}
	if total > 0 && !anyOpen {
		var outputJSON json.RawMessage
		if len(wf.Outputs) > 0 {
			outputJSON, _ = json.Marshal(projectOutputs(wf.Outputs, runContext, runInput))
		}
		payload := map[string]any{"nodes": total}
		if handledFailures > 0 {
			payload["handledFailures"] = handledFailures
		}
		if err := e.flipRunTerminal(ctx, q, events, runID, "succeeded",
			payload, completedAt, outputJSON); err != nil {
			return false, err
		}
		return true, e.appendStatusChecked(ctx, events, runID, completedAt)
	}
	return false, e.appendStatusChecked(ctx, events, runID, completedAt)
}

// appendStatusChecked is the contract's fan-in settle marker: every
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
	if status == "failed" {
		// Nothing of this run is claimable any more; queued siblings leave
		// the claim index (see DemoteQueuedRunNodes). Cancellation handles
		// its own nodes.
		if _, err := q.DemoteQueuedRunNodes(ctx, runID); err != nil {
			return fmt.Errorf("demote queued nodes: %w", err)
		}
	}
	// A validation run carrying a playbook claim reports its outcome here:
	// success refreshes evidence, failure auto-retires (in the same tx as
	// the terminal flip, so evidence and outcome can't drift).
	if err := e.recordPlaybookValidationOutcome(ctx, q, runID, status); err != nil {
		return fmt.Errorf("record playbook validation outcome: %w", err)
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal run event payload: %w", err)
	}
	eventAt := causeAt.Add(time.Millisecond)
	terminalEventID := e.newID()
	events.add(terminalEventID, runID, "", "run."+status, payloadJSON, eventAt)
	if err := e.finalizeSemanticRecoveryMonitoring(
		ctx, q, runID, status, terminalEventID, eventAt,
	); err != nil {
		return fmt.Errorf("finalize semantic recovery monitoring: %w", err)
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
