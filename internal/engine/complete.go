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
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
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

type completionOptions struct {
	beforeSuccess    func(q *store.Queries, events *runEventBuffer, finishedAt time.Time) error
	beforeDownstream func(q *store.Queries, events *runEventBuffer, finishedAt time.Time) error
	skipSuccessEvent bool
}

// CompleteNode commits a successful execution: node succeeded with its
// output, the node.succeeded event (output inlined only under the 8 KB
// threshold), ready successors queued with their node.queued events, and the
// run rolled up to a terminal status when no work remains. Returns without
// error when the CAS finds the node no longer running — another actor owns
// that transition.
func (e *Engine) CompleteNode(ctx context.Context, claim ClaimedNode, output any) error {
	return e.completeNode(ctx, claim, output, completionOptions{})
}

// CompleteRouterNode commits the deterministic decision, its causal event,
// and every losing direct-successor skip in the same completion transaction.
// The readiness scan therefore cannot observe the router as succeeded while
// both branches are still eligible for publication.
func (e *Engine) CompleteRouterNode(ctx context.Context, claim ClaimedNode, plan RouterExecution) error {
	decisionJSON, err := json.Marshal(plan.Decision)
	if err != nil {
		return fmt.Errorf("marshal router decision: %w", err)
	}
	decisionValue := map[string]any{}
	if err := json.Unmarshal(decisionJSON, &decisionValue); err != nil {
		return fmt.Errorf("project router decision: %w", err)
	}
	decisionPayload := safePersist(decisionValue, defaultPersistMaxBytes())
	return e.completeNode(ctx, claim, map[string]any{"decision": decisionValue}, completionOptions{
		// The compatibility runtime uses decision.made as the router's
		// timeline receipt and advances the node row without a second,
		// redundant node.succeeded event carrying the same decision.
		skipSuccessEvent: true,
		beforeSuccess: func(_ *store.Queries, events *runEventBuffer, finishedAt time.Time) error {
			events.add(e.newID(), claim.RunID, claim.NodeID, "decision.made", decisionPayload, finishedAt)
			return nil
		},
		beforeDownstream: func(q *store.Queries, events *runEventBuffer, finishedAt time.Time) error {
			chosen := plan.Decision.ChosenNodeID
			if chosen == "" {
				return nil
			}
			reason := fmt.Sprintf("Router %s chose %s", claim.NodeID, chosen)
			stateJSON := safePersist(map[string]any{"skipped": map[string]any{"reason": reason}}, stateJSONMaxBytes)
			payloadJSON := safePersist(map[string]any{"reason": reason}, defaultPersistMaxBytes())
			for _, candidate := range plan.Candidates {
				if candidate.NodeID == chosen || !plan.SuccessorIDs[candidate.NodeID] {
					continue
				}
				skipped, err := q.SkipRunNode(ctx, store.SkipRunNodeParams{
					RunID: claim.RunID, NodeID: candidate.NodeID,
					StateJson: stateJSON, FinishedAt: &finishedAt,
				})
				if err != nil {
					return fmt.Errorf("skip router candidate %s: %w", candidate.NodeID, err)
				}
				if skipped == 0 {
					continue
				}
				events.add(e.newID(), claim.RunID, candidate.NodeID, "node.skipped", payloadJSON, finishedAt)
				metricNodeCompletions.WithLabelValues("skipped").Inc()
			}
			return nil
		},
	})
}

func (e *Engine) completeNode(ctx context.Context, claim ClaimedNode, output any, opts completionOptions) error {
	if output == nil {
		output = map[string]any{}
	}
	outputJSON, err := json.Marshal(output)
	if err != nil {
		return fmt.Errorf("marshal output: %w", err)
	}
	stateJSON := safePersist(map[string]any{"output": output}, stateJSONMaxBytes)

	// Deterministic semantic interception: evaluate the contract's
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
	if err := e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries, events *runEventBuffer) error {
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
		if err := e.recordRoutingOutcome(ctx, q, claim, 1, true, finishedAt); err != nil {
			return err
		}
		// A consumed retry wake-up dies with the completion — deterministic
		// cleanup, not sweeper-dependent.
		if err := q.DeleteWakeup(ctx, claim.RowID); err != nil {
			return fmt.Errorf("clear wakeup: %w", err)
		}
		if opts.beforeSuccess != nil {
			if err := opts.beforeSuccess(q, events, finishedAt); err != nil {
				return err
			}
		}
		if !opts.skipSuccessEvent {
			events.add(e.newID(), claim.RunID, claim.NodeID, "node.succeeded", eventJSON, finishedAt)
		}
		metricNodeCompletions.WithLabelValues("succeeded").Inc()
		if err := e.recordRecoveryImpact(ctx, q, claim, finishedAt); err != nil {
			return err
		}
		quarantined := false
		if len(violations) > 0 {
			quarantined, err = e.persistSemanticViolations(ctx, q, events, claim, violations, finishedAt)
			if err != nil {
				return err
			}
		}
		if opts.beforeDownstream != nil {
			if err := opts.beforeDownstream(q, events, finishedAt); err != nil {
				return err
			}
		}
		if quarantined {
			// The business-outcome gate: the run parks in waiting BEFORE
			// any downstream node can be scheduled. Router loser skips may
			// already have landed above, matching the compatibility runtime.
			return nil
		}
		return e.scheduleDownstream(ctx, q, events, claim.RunID, finishedAt)
	}); err != nil {
		return err
	}
	// Rollout outcome receipt (post-commit, idempotent; the repair pass
	// covers crash windows). Only meaningful when this completion rolled
	// the run terminal — the recorder re-validates everything itself.
	e.maybeRecordRolloutOutcome(ctx, claim.RunID)
	return nil
}

// recordRoutingOutcome updates the per-tenant reinforcement counter only
// after the caller's node CAS has won. Keeping it on the same transaction
// removes both lost observations and double credit under competing workers.
func (e *Engine) recordRoutingOutcome(
	ctx context.Context, q *store.Queries, claim ClaimedNode,
	reward float32, success bool, recordedAt time.Time,
) error {
	orgID := claim.OrgID
	if orgID == "" {
		run, err := q.GetRunExecution(ctx, claim.RunID)
		if err != nil {
			return fmt.Errorf("resolve routing outcome tenant: %w", err)
		}
		orgID = run.OrgID
	}
	if orgID == "" {
		return nil
	}
	successCount, failureCount := int32(0), int32(1)
	if success {
		successCount, failureCount = 1, 0
	}
	if err := q.RecordRoutingOutcome(ctx, store.RecordRoutingOutcomeParams{
		ID: e.newID(), OrgID: orgID, NodeID: claim.NodeID,
		Reward: reward, SuccessCount: successCount, FailureCount: failureCount,
		UpdatedAt: &recordedAt,
	}); err != nil {
		return fmt.Errorf("record routing outcome: %w", err)
	}
	return nil
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
	ctx context.Context, q *store.Queries, events *runEventBuffer, claim ClaimedNode,
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
		events.add(e.newID(), claim.RunID, claim.NodeID, "recovery.semantic_violation", payload, finishedAt)
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

// RetryOrFail is the worker's failure decision, mirroring the contract's
// catch block: under the node's declared retry policy an eligible failure
// requeues the node with attempt+1 and a wake-up at the computed backoff;
// anything else commits the terminal failure with its dead-letter capture.

var errSkipCommit = errors.New("skip commit: node transition lost the compare-and-set")

// inCompletionTx runs handler inside one transaction that holds the per-run
// completion lock. The lock releases on commit, which is what guarantees a
// concurrent sibling's readiness scan reads this transaction's writes.
func (e *Engine) inCompletionTx(ctx context.Context, runID string, handler func(q *store.Queries, events *runEventBuffer) error) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	if err := q.AcquireRunCompletionLock(ctx, runID); err != nil {
		return fmt.Errorf("acquire completion lock: %w", err)
	}
	events := &runEventBuffer{}
	if err := handler(q, events); err != nil {
		if errors.Is(err, errSkipCommit) {
			return nil
		}
		return err
	}
	// Every buffered timeline event lands in ONE CopyFrom round trip, and
	// the stream signal rides the same commit.
	if err := events.flush(ctx, q); err != nil {
		return err
	}
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

// eventNow stamps run events at MILLISECOND precision — the contract's
// timestamps come from JS Dates (ms), and keyset cursors serialize as
// millisecond ISO strings on both backends. A µs-precision row under an
// ms-precision cursor can be skipped at a page boundary; truncating at
// write time makes every cursor comparison exact in both directions.
func eventNow() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// recordRecoveryImpact credits one generation-bound terminal success INSIDE
// the completion transaction, implements the contract's
// recordRecoveryImpactTx: the completing node must carry the recovery
// claim its redrive stamped; the dead letter must still match by exact
// identity (id + run + node); the impact event is idempotent on the
// unique dead_letter_id (a racing double terminal can never double-count);
// and only PRODUCTION recoveries (replay_mode null) enter the O(1)
// north-star rollup. Replay initiation is never a recovered win — only
// this terminal path credits.
