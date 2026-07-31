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
	"github.com/johnny4young/janusly/go/internal/recovery"
	"github.com/johnny4young/janusly/go/internal/store"
)

// ClaimedNode identifies one claimed queue delivery.
type ClaimedNode struct {
	RowID   string
	RunID   string
	NodeID  string
	Attempt int32
	// OrgID is populated from the run row at execution time so downstream
	// per-tenant resolution (org config bounds) never re-reads the run.
	OrgID string
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
	stateJSON := safePersist(map[string]any{"output": output}, stateJSONMaxBytes)

	// Deterministic semantic interception (T-132): evaluate the contract's
	// detectors for this source node BEFORE the completion transaction, on
	// the pre-completion context snapshot with the exact output overlaid.
	violations, evalErr := e.evaluateSemanticOutcome(ctx, claim, output)
	if evalErr != nil {
		return evalErr
	}

	var eventPayload map[string]any
	if len(outputJSON) <= nodeSucceededOutputMaxBytes {
		eventPayload = map[string]any{"output": output, "attempt": claim.Attempt}
	} else {
		eventPayload = map[string]any{
			"outputBytes": len(outputJSON), "outputTruncated": true, "attempt": claim.Attempt,
		}
	}
	eventJSON := safePersist(eventPayload, defaultPersistMaxBytes())

	finishedAt := eventNow()
	return e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries) error {
		completed, err := q.CompleteRunNode(ctx, store.CompleteRunNodeParams{
			RunID: claim.RunID, NodeID: claim.NodeID,
			StateJson:  stateJSON,
			FinishedAt: &finishedAt,
		})
		if err != nil {
			return fmt.Errorf("complete node: %w", err)
		}
		if completed == 0 {
			return errSkipCommit
		}
		// A consumed retry wake-up dies with the completion — deterministic
		// cleanup, not sweeper-dependent.
		if err := q.DeleteWakeup(ctx, claim.RowID); err != nil {
			return fmt.Errorf("clear wakeup: %w", err)
		}
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: claim.RunID,
			NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
			Type:   "node.succeeded", Payload: eventJSON, CreatedAt: &finishedAt,
		}); err != nil {
			return fmt.Errorf("insert node.succeeded: %w", err)
		}
		metricNodeCompletions.WithLabelValues("succeeded").Inc()
		if err := e.recordRecoveryImpact(ctx, q, claim, finishedAt); err != nil {
			return err
		}
		if len(violations) > 0 {
			quarantined, err := e.persistSemanticViolations(ctx, q, claim, violations, finishedAt)
			if err != nil {
				return err
			}
			if quarantined {
				// The business-outcome gate: the run parks in waiting BEFORE
				// any downstream node can be scheduled.
				return nil
			}
		}
		return e.scheduleDownstream(ctx, q, claim.RunID, finishedAt)
	})
}

// evaluateSemanticOutcome runs the contract's deterministic detectors for
// the completing node. Sandbox replays (replayMode=validation) are
// excluded: a dry-run must not create durable business-outcome cases.
func (e *Engine) evaluateSemanticOutcome(ctx context.Context, claim ClaimedNode, output any) ([]recovery.SemanticOutcomeViolation, error) {
	run, err := store.New(e.pool).GetRunExecution(ctx, claim.RunID)
	if err != nil {
		return nil, fmt.Errorf("read run for semantic evaluation: %w", err)
	}
	if run.ReplayMode.Valid && run.ReplayMode.String != "" {
		return nil, nil
	}
	wf, _, err := workflowFromRunInput(run.InputJson)
	if err != nil || wf.Recovery == nil || wf.Recovery.Contract == nil || wf.Recovery.Contract.Version != "2" {
		return nil, nil
	}
	relevant := false
	for _, detector := range wf.Recovery.Contract.Failure.Semantic.Detectors {
		if detector.SourceNodeID == claim.NodeID {
			relevant = true
			break
		}
	}
	if !relevant {
		return nil, nil
	}
	rows, err := store.New(e.pool).ListRunNodesByRun(ctx, claim.RunID)
	if err != nil {
		return nil, fmt.Errorf("read context for semantic evaluation: %w", err)
	}
	runContext := runContextFromRows(rows)
	evaluation := recovery.EvaluateSemanticOutcome(struct {
		Contract     *domain.RecoveryContract
		SourceNodeID string
		Output       any
		Context      map[string]any
	}{
		Contract: wf.Recovery.Contract, SourceNodeID: claim.NodeID,
		Output: output, Context: runContext,
	})
	return evaluation.Violations, nil
}

// persistSemanticViolations writes the durable cases, containment
// receipts, timeline events, and the run's outcome projection INSIDE the
// completion transaction — quarantine parks the run in waiting atomically
// with node success, so no downstream node can be scheduled past an
// unresolved business outcome.
func (e *Engine) persistSemanticViolations(
	ctx context.Context, q *store.Queries, claim ClaimedNode,
	violations []recovery.SemanticOutcomeViolation, finishedAt time.Time,
) (bool, error) {
	run, err := q.GetRunExecution(ctx, claim.RunID)
	if err != nil {
		return false, fmt.Errorf("read run for semantic persistence: %w", err)
	}
	wf, _, err := workflowFromRunInput(run.InputJson)
	if err != nil {
		return false, err
	}
	for _, violation := range violations {
		caseID := StableSemanticID("sem", run.OrgID, claim.RunID, violation.DetectorID)
		state := "detected"
		if violation.Action == "quarantine" {
			state = "contained"
		}
		details := violation.Details
		if len(details) > 50 {
			details = details[:50]
		}
		detailsJSON, _ := json.Marshal(details)
		if err := q.InsertRecoveryCase(ctx, store.InsertRecoveryCaseParams{
			ID: caseID, OrgID: run.OrgID, RunID: claim.RunID,
			WorkflowID:        pgtype.Text{String: wf.ID, Valid: wf.ID != ""},
			WorkflowVersionID: wf.ID,
			Source:            "semantic_violation", DetectorID: violation.DetectorID,
			SourceNodeID: violation.SourceNodeID, DetectorKind: violation.Kind,
			Action: violation.Action, Message: violation.Message,
			DetailsJson: detailsJSON, State: state,
			CreatedBy: pgtype.Text{},
		}); err != nil {
			return false, fmt.Errorf("insert semantic case: %w", err)
		}
		if violation.Action == "quarantine" {
			evidenceJSON, _ := json.Marshal([]domain.RecoveryCaseEvidenceRef{
				{Kind: "run_node", ID: claim.RunID + ":" + claim.NodeID},
				{Kind: "semantic_detector", ID: violation.DetectorID},
			})
			if _, err := q.InsertRecoveryCaseTransition(ctx, store.InsertRecoveryCaseTransitionParams{
				ID:    StableSemanticID("sct", caseID, "contained"),
				OrgID: run.OrgID, CaseID: caseID,
				FromState: "detected", ToState: "contained",
				ActorKind: "system", ActorID: pgtype.Text{},
				EvidenceJson: evidenceJSON, Reason: pgtype.Text{},
				OccurredAt: finishedAt,
			}); err != nil {
				return false, fmt.Errorf("insert containment receipt: %w", err)
			}
		}
		payload := safePersist(map[string]any{
			"caseId": caseID, "detectorId": violation.DetectorID,
			"sourceNodeId": violation.SourceNodeID, "kind": violation.Kind,
			"action": violation.Action, "message": violation.Message,
			"details": details,
		}, defaultPersistMaxBytes())
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: claim.RunID,
			NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
			Type:   "recovery.semantic_violation", Payload: payload, CreatedAt: &finishedAt,
		}); err != nil {
			return false, fmt.Errorf("insert semantic_violation event: %w", err)
		}
	}

	counts, err := q.CountRunSemanticCases(ctx, store.CountRunSemanticCasesParams{
		OrgID: run.OrgID, RunID: claim.RunID,
	})
	if err != nil {
		return false, fmt.Errorf("count semantic cases: %w", err)
	}
	quarantined := counts.OpenQuarantines > 0
	outcomeStatus := "semantic_violation"
	if quarantined {
		outcomeStatus = "semantic_quarantined"
	}
	if err := q.SetRunSemanticOutcome(ctx, store.SetRunSemanticOutcomeParams{
		ID: claim.RunID, Quarantine: quarantined,
		OutcomeStatus:  pgtype.Text{String: outcomeStatus, Valid: true},
		ViolationCount: int32(counts.Total),
	}); err != nil {
		return false, fmt.Errorf("set run semantic outcome: %w", err)
	}
	return quarantined, nil
}

// RetryOrFail is the worker's failure decision, mirroring the reference's
// catch block: under the node's declared retry policy an eligible failure
// requeues the node with attempt+1 and a wake-up at the computed backoff;
// anything else commits the terminal failure with its dead-letter capture.
func (e *Engine) RetryOrFail(ctx context.Context, claim ClaimedNode, node domain.Node, execErr error) error {
	serr := serializeError(execErr)
	policy := parseRetryPolicy(node.Config)
	maxAttempts := 1
	if policy != nil && policy.MaxAttempts > 0 {
		maxAttempts = policy.MaxAttempts
	}
	if int(claim.Attempt) >= maxAttempts || !shouldRetry(serr, policy) {
		return e.FailNode(ctx, claim, execErr)
	}

	nextAttempt := claim.Attempt + 1
	delayMs := computeRetryDelay(int(nextAttempt), policy, e.randFloat)
	wakeAt := e.now().UTC().Add(time.Duration(delayMs) * time.Millisecond)
	eventJSON, err := json.Marshal(map[string]any{
		"attempt": nextAttempt, "delayMs": delayMs, "error": serr,
	})
	if err != nil {
		return fmt.Errorf("marshal retry payload: %w", err)
	}
	retriedAt := eventNow()
	return e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries) error {
		requeued, err := q.RequeueRunNodeForRetry(ctx, store.RequeueRunNodeForRetryParams{
			RunID: claim.RunID, NodeID: claim.NodeID,
			Attempt: pgtype.Int4{Int32: nextAttempt, Valid: true},
		})
		if err != nil {
			return fmt.Errorf("requeue for retry: %w", err)
		}
		if requeued == 0 {
			return errSkipCommit
		}
		metricNodeRetries.Inc()
		// The wake-up rides the same transaction: the anti-join on the claim
		// keeps the row unclaimable until the backoff clock passes.
		if err := q.UpsertWakeup(ctx, store.UpsertWakeupParams{
			RunNodeID: claim.RowID, WakeAt: wakeAt, Reason: "retry",
		}); err != nil {
			return fmt.Errorf("schedule retry wakeup: %w", err)
		}
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: claim.RunID,
			NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
			Type:   "node.retry", Payload: eventJSON, CreatedAt: &retriedAt,
		}); err != nil {
			return fmt.Errorf("insert node.retry: %w", err)
		}
		return nil
	})
}

// FailNode commits the terminal execution failure atomically: the node CAS
// to failed, the dead-letter row carrying the exact workflow/node/error
// snapshots for replay, the node.failed event, and the run flipped to
// failed — one transaction, so a half-failed run can never strand.
func (e *Engine) FailNode(ctx context.Context, claim ClaimedNode, execErr error) error {
	serr := serializeError(execErr)
	eventJSON, err := json.Marshal(map[string]any{"error": serr, "attempt": claim.Attempt})
	if err != nil {
		return fmt.Errorf("marshal event payload: %w", err)
	}

	failedAt := eventNow()
	return e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries) error {
		run, err := q.GetRunExecution(ctx, claim.RunID)
		if err != nil {
			return fmt.Errorf("read run: %w", err)
		}
		if run.Status != "running" && run.Status != "failed" {
			// Cancellation landed first; the node keeps its state elsewhere.
			return errSkipCommit
		}
		failed, err := q.FailRunNode(ctx, store.FailRunNodeParams{
			RunID: claim.RunID, NodeID: claim.NodeID,
			ErrorJson:  safePersist(serr, deadLetterErrorMaxBytes),
			FinishedAt: &failedAt,
		})
		if err != nil {
			return fmt.Errorf("fail node: %w", err)
		}
		if failed == 0 {
			return errSkipCommit
		}
		metricNodeCompletions.WithLabelValues("failed").Inc()
		if err := q.DeleteWakeup(ctx, claim.RowID); err != nil {
			return fmt.Errorf("clear wakeup: %w", err)
		}

		if err := e.insertDeadLetter(ctx, q, claim, run, serr, failedAt); err != nil {
			return err
		}

		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: claim.RunID,
			NodeID: pgtype.Text{String: claim.NodeID, Valid: true},
			Type:   "node.failed", Payload: eventJSON, CreatedAt: &failedAt,
		}); err != nil {
			return fmt.Errorf("insert node.failed: %w", err)
		}

		if run.Status == "failed" {
			return nil
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

// insertDeadLetter captures the exact failed job for operator replay: the
// full workflow and node snapshots (key-redacted, never size-truncated —
// replay needs the exact JSON) plus the bounded error.
func (e *Engine) insertDeadLetter(ctx context.Context, q *store.Queries, claim ClaimedNode, run store.GetRunExecutionRow, serr map[string]any, failedAt time.Time) error {
	var envelope struct {
		Workflow any `json:"workflow"`
	}
	_ = json.Unmarshal(run.InputJson, &envelope)
	workflowJSON := safePersist(envelope.Workflow, 0)

	var nodeSnapshot any
	if wf, _, err := workflowFromRunInput(run.InputJson); err == nil {
		for i := range wf.Nodes {
			if wf.Nodes[i].ID == claim.NodeID {
				raw, _ := json.Marshal(wf.Nodes[i])
				_ = json.Unmarshal(raw, &nodeSnapshot)
				break
			}
		}
	}
	if err := q.InsertDeadLetter(ctx, store.InsertDeadLetterParams{
		ID: e.newID(), OrgID: run.OrgID, RunID: claim.RunID, NodeID: claim.NodeID,
		Attempt:      claim.Attempt,
		WorkflowJson: workflowJSON,
		NodeJson:     safePersist(nodeSnapshot, 0),
		ErrorJson:    safePersist(serr, deadLetterErrorMaxBytes),
	}); err != nil {
		return fmt.Errorf("insert dead letter: %w", err)
	}
	return nil
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
	// Every completion-family transaction appends timeline events; the
	// stream signal rides the same commit.
	if err := q.NotifyRunEvents(ctx, runID); err != nil {
		return fmt.Errorf("notify run events: %w", err)
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
					if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
						ID: e.newID(), RunID: runID,
						NodeID: pgtype.Text{String: node.ID, Valid: true},
						Type:   "node.skipped", Payload: payload, CreatedAt: &skippedAt,
					}); err != nil {
						return fmt.Errorf("insert node.skipped: %w", err)
					}
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
	metricRunsTerminal.WithLabelValues(status).Inc()
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

// eventNow stamps run events at MILLISECOND precision — the reference's
// timestamps come from JS Dates (ms), and keyset cursors serialize as
// millisecond ISO strings on both backends. A µs-precision row under an
// ms-precision cursor can be skipped at a page boundary; truncating at
// write time makes every cursor comparison exact in both directions.
func eventNow() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// recordRecoveryImpact credits one generation-bound terminal success INSIDE
// the completion transaction, ported from the reference's
// recordRecoveryImpactTx: the completing node must carry the recovery
// claim its redrive stamped; the dead letter must still match by exact
// identity (id + run + node); the impact event is idempotent on the
// unique dead_letter_id (a racing double terminal can never double-count);
// and only PRODUCTION recoveries (replay_mode null) enter the O(1)
// north-star rollup. Replay initiation is never a recovered win — only
// this terminal path credits.
func (e *Engine) recordRecoveryImpact(ctx context.Context, q *store.Queries, claim ClaimedNode, recoveredAt time.Time) error {
	nodeClaim, err := q.GetRunNodeRecoveryClaim(ctx, store.GetRunNodeRecoveryClaimParams{
		RunID: claim.RunID, NodeID: claim.NodeID,
	})
	if err != nil || !nodeClaim.RecoveryDeadLetterID.Valid || nodeClaim.RecoveryDeadLetterID.String == "" {
		return nil
	}
	deadLetterID := nodeClaim.RecoveryDeadLetterID.String
	dlq, err := q.GetDeadLetterForImpact(ctx, store.GetDeadLetterForImpactParams{
		ID: deadLetterID, RunID: claim.RunID, NodeID: claim.NodeID,
	})
	if err != nil {
		// Exact identity no longer matches — a stale claim credits nothing.
		return nil
	}
	if dlq.CreatedAt == nil {
		return nil
	}
	detectedAt := dlq.CreatedAt.UTC()
	if recoveredAt.Before(detectedAt) {
		return nil
	}
	downtimeMs := recoveredAt.Sub(detectedAt).Milliseconds()

	if err := q.ConvergeDeadLetterReplayed(ctx, store.ConvergeDeadLetterReplayedParams{
		ID: deadLetterID, OrgID: dlq.OrgID, RecoveredAt: &recoveredAt,
	}); err != nil {
		return fmt.Errorf("converge dead letter: %w", err)
	}
	inserted, err := q.InsertRecoveryImpactEvent(ctx, store.InsertRecoveryImpactEventParams{
		DeadLetterID: deadLetterID, OrgID: dlq.OrgID,
		RunID: claim.RunID, NodeID: claim.NodeID,
		UserID:      nodeClaim.RecoveryRequestedBy,
		RecoveredAt: recoveredAt, DowntimeEndedMs: downtimeMs,
	})
	if err != nil {
		return fmt.Errorf("insert impact event: %w", err)
	}
	if inserted == 0 {
		// The unique dead_letter_id already holds a win — idempotent.
		return nil
	}
	// Only production recoveries enter the north-star rollup; validation
	// drills keep their immutable fact above but never inflate value.
	if !dlq.ReplayMode.Valid || dlq.ReplayMode.String == "" {
		if err := q.UpsertRecoveryImpactRollup(ctx, store.UpsertRecoveryImpactRollupParams{
			OrgID: dlq.OrgID, DowntimeEndedMs: downtimeMs, RecoveredAt: &recoveredAt,
		}); err != nil {
			return fmt.Errorf("upsert impact rollup: %w", err)
		}
	}
	return nil
}
