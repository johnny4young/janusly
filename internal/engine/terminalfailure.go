// Terminal node failure: retry-or-fail with the writeSide
// no-retry channel, the dead-letter insert + recovery-item hook, the
// post-failure breaker/alert hooks, and generation-bound recovery impact.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

func (e *Engine) RetryOrFail(ctx context.Context, claim ClaimedNode, node domain.Node, execErr error) error {
	serr := serializeError(execErr)
	policy := parseRetryPolicy(node.Config)
	maxAttempts := 1
	if policy != nil && policy.MaxAttempts > 0 {
		maxAttempts = policy.MaxAttempts
	}
	// A writeSide error means external effects may already have happened —
	// never whole-node retry it; operator-gated
	// replay is safer than duplicate effects.
	if serr["writeSide"] == true || int(claim.Attempt) >= maxAttempts || !shouldRetry(serr, policy) {
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
	retriedAt := e.eventNow()
	return e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries, events *runEventBuffer) error {
		requeued, err := q.RequeueRunNodeForRetry(ctx, store.RequeueRunNodeForRetryParams{
			RunID: claim.RunID, NodeID: claim.NodeID,
			Attempt: pgtype.Int4{Int32: nextAttempt, Valid: true},
			WakeAt:  &wakeAt,
		})
		if err != nil {
			return fmt.Errorf("requeue for retry: %w", err)
		}
		if requeued == 0 {
			return errSkipCommit
		}
		if err := e.recordRoutingOutcome(ctx, q, claim, -1, false, retriedAt); err != nil {
			return err
		}
		metricNodeRetries.Inc()
		// The wake-up rides the same transaction: the anti-join on the claim
		// keeps the row unclaimable until the backoff clock passes.
		if err := q.UpsertWakeup(ctx, store.UpsertWakeupParams{
			RunNodeID: claim.RowID, WakeAt: wakeAt, Reason: "retry",
		}); err != nil {
			return fmt.Errorf("schedule retry wakeup: %w", err)
		}
		events.add(e.newID(), claim.RunID, claim.NodeID, "node.retry", eventJSON, retriedAt)
		return nil
	})
}

// FailNode commits the terminal execution failure atomically: the node CAS
// to failed, the dead-letter row carrying the exact workflow/node/error
// snapshots for replay, the node.failed event, and the run flipped to
// failed — one transaction, so a half-failed run can never strand.
func (e *Engine) FailNode(ctx context.Context, claim ClaimedNode, execErr error) error {
	return e.failNodeWithEventFields(ctx, claim, execErr, nil)
}

// failNodeWithEventFields preserves the ordinary atomic failure boundary while
// allowing a server-owned recovery mechanism to attach bounded causal facts to
// node.failed. Executor errors must use FailNode; callers cannot replace the
// canonical error or attempt fields.
func (e *Engine) failNodeWithEventFields(ctx context.Context, claim ClaimedNode, execErr error, fields map[string]any) error {
	committed, handled, err := e.failNodeTx(ctx, claim, execErr, fields)
	if err != nil {
		return err
	}
	if !committed {
		// The CAS went to someone else (a racing reaper, a cancellation).
		// That winner owns the post-commit side effects; running them here
		// too would page twice for one failure.
		return nil
	}
	if handled {
		// A handled failure is not an incident: no breaker, no DLQ alert.
		// The run continues; terminal bookkeeping fires from whichever
		// completion settles it. The rollout receipt and memory summary
		// still run here because the handled branch may have settled the
		// run terminal inside this very transaction.
		e.maybeRecordRolloutOutcome(ctx, claim.RunID)
		e.maybeCommitRunSummaryMemory(ctx, claim.RunID)
		return nil
	}
	// Containment rides OUTSIDE the durable failure: a breaker fault must
	// never break the DLQ path that already committed.
	e.afterTerminalFailure(ctx, claim)
	return nil
}

func (e *Engine) failNodeTx(ctx context.Context, claim ClaimedNode, execErr error, fields map[string]any) (committed, handled bool, err error) {
	serr := serializeError(execErr)
	eventPayload := map[string]any{"error": serr, "attempt": claim.Attempt}
	for key, value := range fields {
		if _, canonical := eventPayload[key]; !canonical {
			eventPayload[key] = value
		}
	}
	eventJSON, err := json.Marshal(eventPayload)
	if err != nil {
		return false, false, fmt.Errorf("marshal event payload: %w", err)
	}

	failedAt := e.eventNow()
	committed, err = e.inCompletionTxCommitted(ctx, claim.RunID, func(q *store.Queries, events *runEventBuffer) error {
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
		claim.OrgID = run.OrgID
		if err := e.recordRoutingOutcome(ctx, q, claim, -1, false, failedAt); err != nil {
			return err
		}
		metricNodeCompletions.WithLabelValues("failed").Inc()
		if err := q.DeleteWakeup(ctx, claim.RowID); err != nil {
			return fmt.Errorf("clear wakeup: %w", err)
		}

		// A failure with an on-error route is HANDLED: the author declared
		// it expected. No dead letter (there is nothing for an operator to
		// recover — the workflow recovers itself), no terminal flip; the
		// error branch schedules inside this same transaction.
		wf := claim.snapshot.workflowOr(nil)
		if wf == nil {
			wf, _, _ = workflowFromRunInput(run.InputJson)
		}
		if wf != nil && run.Status == "running" && nodeFailureHandled(wf, claim.NodeID) {
			handled = true
			handledPayload := map[string]any{"error": serr, "attempt": claim.Attempt, "handled": true}
			handledJSON, err := json.Marshal(handledPayload)
			if err != nil {
				return fmt.Errorf("marshal handled payload: %w", err)
			}
			events.add(e.newID(), claim.RunID, claim.NodeID, "node.failed", handledJSON, failedAt)
			_, err = e.scheduleDownstream(ctx, q, events, claim, failedAt)
			return err
		}

		if err := e.insertDeadLetter(ctx, q, claim, run, serr, failedAt); err != nil {
			return err
		}

		events.add(e.newID(), claim.RunID, claim.NodeID, "node.failed", eventJSON, failedAt)

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
		return e.flipRunTerminal(ctx, q, events, claim.RunID, "failed",
			map[string]any{"failedNodes": failedNodes}, failedAt, nil)
	})
	return committed, handled, err
}

// afterTerminalFailure runs the breaker evaluation OUTSIDE the completion
// transaction (best-effort containment; the dead letter is already
// durable). Sandbox replays never reach it — the streak query excludes
// them and a validation run's failure carries replay_mode.
func (e *Engine) afterTerminalFailure(ctx context.Context, claim ClaimedNode) {
	run, err := store.New(e.pool).GetRunExecution(ctx, claim.RunID)
	if err != nil || (run.ReplayMode.Valid && run.ReplayMode.String != "") {
		return
	}
	wf, _, err := workflowFromRunInput(run.InputJson)
	if err != nil {
		return
	}
	e.maybeTripCircuitBreaker(ctx, run.OrgID, wf.ID, claim.RunID)
	// Rollout outcome receipt (idempotent; repair covers crash windows).
	e.maybeRecordRolloutOutcome(ctx, claim.RunID)
	e.maybeCommitRunSummaryMemory(ctx, claim.RunID)
	// Alert producer: the dead letter is durable (committed with the
	// failure tx), so the dlq.entry_created event fires here, after commit.
	if dl, err := store.New(e.pool).FindLatestDeadLetterForNode(ctx, store.FindLatestDeadLetterForNodeParams{
		OrgID: run.OrgID, RunID: claim.RunID, NodeID: claim.NodeID,
	}); err == nil {
		e.DispatchAlert(ctx, run.OrgID, "dlq.entry_created", map[string]any{
			"deadLetterId": dl.ID, "runId": claim.RunID, "nodeId": claim.NodeID,
			"workflowId":     wf.ID,
			"errorSignature": deadLetterSignatureFromParts(dl.NodeID, dl.NodeJson, dl.ErrorJson),
			"dedupeKey":      "dlq:" + wf.ID + ":" + claim.NodeID,
		})
	}
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
	deadLetterID := e.newID()
	nodeJSON := safePersist(nodeSnapshot, 0)
	errorJSON := safePersist(serr, deadLetterErrorMaxBytes)
	if err := q.InsertDeadLetter(ctx, store.InsertDeadLetterParams{
		ID: deadLetterID, OrgID: run.OrgID, RunID: claim.RunID, NodeID: claim.NodeID,
		Attempt:      claim.Attempt,
		WorkflowJson: workflowJSON,
		NodeJson:     nodeJSON,
		ErrorJson:    errorJSON,
		ReplayMode:   run.ReplayMode,
	}); err != nil {
		return fmt.Errorf("insert dead letter: %w", err)
	}
	if run.ReplayMode.Valid && run.ReplayMode.String != "" {
		// A sandbox validation's failure is evidence for its dialog or
		// drill: the row exists for direct-by-id reads, but it must not
		// open an operator incident — a dry-run cannot create durable
		// business-outcome work.
		return nil
	}
	// Ownership hook: the incident opens with its dead letter (same tx);
	// blips degrade to "no incident", never a failed completion.
	workflowID := ""
	var wfDoc struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(workflowJSON, &wfDoc)
	workflowID = wfDoc.ID
	e.autoCreateRecoveryItem(ctx, q, AutoCreateRecoveryItemInput{
		OrgID: run.OrgID, DeadLetterID: deadLetterID, WorkflowID: workflowID,
		ErrorSignature: deadLetterSignatureFromParts(claim.NodeID, nodeJSON, errorJSON),
		CreatedBy:      "system",
	})
	return nil
}

// errSkipCommit aborts the transaction without reporting an error to the
// caller: the CAS lost, so another actor owns the node's terminal state.

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

	// The incident closes ONLY alongside terminal node success — this CAS
	// + its audit ride the same transaction as the impact fact, so
	// enqueue acceptance can never masquerade as recovery and the Value
	// Dashboard and ownership views cannot drift through a crash gap.
	actor := "system"
	if nodeClaim.RecoveryRequestedBy.Valid && nodeClaim.RecoveryRequestedBy.String != "" {
		actor = nodeClaim.RecoveryRequestedBy.String
	}
	item, err := q.FindRecoveryItemForDeadLetter(ctx, store.FindRecoveryItemForDeadLetterParams{
		OrgID: dlq.OrgID, DeadLetterID: deadLetterID,
	})
	if err == nil && item.Status != "resolved" {
		firstActionAt := recoveredAt
		if dlq.ReplayClaimedAt != nil {
			firstActionAt = dlq.ReplayClaimedAt.UTC()
		} else if dlq.ReplayedAt != nil {
			firstActionAt = dlq.ReplayedAt.UTC()
		}
		resolved, err := q.ResolveRecoveryItemFromTerminal(ctx, store.ResolveRecoveryItemFromTerminalParams{
			OrgID: dlq.OrgID, ID: item.ID,
			Actor:         pgtype.Text{String: actor, Valid: true},
			RecoveredAt:   &recoveredAt,
			FirstActionAt: &firstActionAt,
			FromStatus:    item.Status,
		})
		if err != nil {
			return fmt.Errorf("resolve recovery item: %w", err)
		}
		if resolved > 0 {
			metadata, _ := json.Marshal(map[string]any{
				"before": map[string]any{"status": item.Status},
				"after":  map[string]any{"status": "resolved", "resolutionReason": "sandbox_replay_succeeded"},
				"via":    "terminal_recovery",
			})
			if err := q.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
				ID: e.newID(), OrgID: dlq.OrgID,
				UserID:     pgtype.Text{String: actor, Valid: true},
				Action:     "recovery.item.resolved",
				TargetType: pgtype.Text{String: "recovery-item", Valid: true},
				TargetID:   pgtype.Text{String: item.ID, Valid: true},
				Metadata:   metadata,
			}); err != nil {
				return fmt.Errorf("audit item resolution: %w", err)
			}
		}
	}

	// Playbook attribution: a claim that carried a playbook + its
	// validation run credits the playbook's applied win atomically — the
	// DURABLE receipt (successful_uses++, set-once on the validation run)
	// and its audit ride the same transaction as the impact fact.
	if nodeClaim.RecoveryPlaybookID.Valid && nodeClaim.RecoveryPlaybookID.String != "" &&
		nodeClaim.RecoveryValidationRunID.Valid && nodeClaim.RecoveryValidationRunID.String != "" {
		applied, err := e.recordPlaybookAppliedWithQueries(
			ctx, q, dlq.OrgID, nodeClaim.RecoveryPlaybookID.String,
			nodeClaim.RecoveryValidationRunID.String, deadLetterID, actor,
		)
		if err != nil {
			return fmt.Errorf("record playbook applied: %w", err)
		}
		if !applied {
			// The same validation run already credited — idempotent.
			return nil
		}
	}
	return nil
}
