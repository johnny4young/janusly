// The waiting lifecycle: a node pauses (approval, wait_until), the run stays
// running, and resumption — human or timer — completes the still-waiting
// node with the compare-and-set the whole engine relies on, so a duplicate
// resume can never double-write output or double-queue downstream work.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/resumetoken"
	"github.com/johnny4young/janusly/internal/store"
)

// ErrResumeConflict reports a resume against a node that is not waiting —
// the API maps it to 409, matching the contract's ResumeRunConflictError.
var ErrResumeConflict = errors.New("Node is not waiting") //nolint:staticcheck // contract message is the wire contract

// ErrResumeNodeNotFound reports a resume naming a node outside the run's
// workflow snapshot.
var ErrResumeNodeNotFound = errors.New("Node not found") //nolint:staticcheck // contract message is the wire contract

// MarkNodeWaiting commits the pause checkpoint: node running→waiting with
// {waiting: {reason, ...metadata, waitingSince}} state, the node.waiting
// event, and any reason-specific timer/approval wake-up.
func (e *Engine) MarkNodeWaiting(ctx context.Context, claim ClaimedNode, waiting executors.Waiting) error {
	checkpointAt := e.eventNow()
	metadata := map[string]any{}
	if waiting.Reason != "" {
		metadata["reason"] = waiting.Reason
	}
	maps.Copy(metadata, waiting.Metadata)
	if metadata["kind"] == "human_form" {
		// The engine signs here — org TTL policy + the dedicated secret
		// stay out of the executor. The signed expiry travels with the
		// link; policy changes only affect tokens issued afterwards.
		ttl := int(orgconfig.LoadNumber(ctx, e.pool, claim.OrgID, "runs.humanFormResumeTtlSeconds"))
		if ttl < resumetoken.MinTTLSeconds || ttl > resumetoken.DefaultTTLSeconds {
			ttl = resumetoken.DefaultTTLSeconds
		}
		token, err := resumetoken.Sign(resumetoken.Binding{
			OrgID: claim.OrgID, RunID: claim.RunID, NodeID: claim.NodeID, Purpose: "human_form",
		}, ttl)
		if err != nil {
			return fmt.Errorf("sign resume token: %w", err)
		}
		metadata["resumeToken"] = token
		metadata["resumeTokenExpiresAt"] = time.Now().Add(time.Duration(ttl) * time.Second).UTC().Format(time.RFC3339)
	}
	metadata = domain.MaterializeApprovalWaitingMetadata(metadata, checkpointAt)
	metadata["waitingSince"] = checkpointAt.Format("2006-01-02T15:04:05.000Z")

	var wakeAt *time.Time
	var wakeReason string
	switch metadata["kind"] {
	case "timer":
		wakeAt = waiting.WakeAt
		wakeReason = "wait_until"
	case "approval":
		if rawDeadline, ok := metadata["deadlineAt"].(string); ok {
			wakeAt = domain.ParseAbsoluteInstant(rawDeadline)
			if wakeAt == nil {
				return fmt.Errorf("approval waiting checkpoint has invalid deadlineAt %q", rawDeadline)
			}
			wakeReason = "approval_timeout"
		}
	}
	stateJSON := safePersist(map[string]any{"waiting": metadata}, stateJSONMaxBytes)
	eventJSON := safePersist(map[string]any{
		"status": "waiting", "reason": waiting.Reason, "metadata": metadata,
	}, defaultPersistMaxBytes())

	return e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries, events *runEventBuffer) error {
		marked, err := q.MarkRunNodeWaiting(ctx, store.MarkRunNodeWaitingParams{
			RunID: claim.RunID, NodeID: claim.NodeID, StateJson: stateJSON,
		})
		if err != nil {
			return fmt.Errorf("mark waiting: %w", err)
		}
		if marked == 0 {
			return errSkipCommit
		}
		events.add(e.newID(), claim.RunID, claim.NodeID, "node.waiting", eventJSON, checkpointAt)
		// A claim may arrive after a retry wakeup became due. Replacing or
		// clearing it in the same checkpoint transaction prevents a human wait
		// from inheriting a retry clock and auto-resuming.
		if err := q.DeleteWakeup(ctx, claim.RowID); err != nil {
			return fmt.Errorf("clear execution wakeup: %w", err)
		}
		if wakeAt != nil {
			if err := q.UpsertWakeup(ctx, store.UpsertWakeupParams{
				RunNodeID: claim.RowID, WakeAt: wakeAt.UTC(), Reason: wakeReason,
			}); err != nil {
				return fmt.Errorf("schedule %s wakeup: %w", wakeReason, err)
			}
		}
		return nil
	})
}

// processApprovalTimeout applies one exact persisted deadline generation.
// The per-run completion lock serializes it with manual resume/cancellation;
// the node predicates still form the durable CAS for duplicate HA sweepers.
func (e *Engine) processApprovalTimeout(
	ctx context.Context,
	runID, nodeID string,
	expectedWakeAt time.Time,
) (bool, error) {
	applied := false
	err := e.inCompletionTx(ctx, runID, func(q *store.Queries, events *runEventBuffer) error {
		run, err := q.GetRunExecution(ctx, runID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errSkipCommit
			}
			return fmt.Errorf("read approval run: %w", err)
		}
		if run.Status != "running" {
			return errSkipCommit
		}
		node, err := q.GetRunNode(ctx, store.GetRunNodeParams{RunID: runID, NodeID: nodeID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errSkipCommit
			}
			return fmt.Errorf("read waiting approval: %w", err)
		}
		if node.Status != "waiting" {
			return errSkipCommit
		}
		var state map[string]any
		if err := json.Unmarshal(node.StateJson, &state); err != nil {
			return fmt.Errorf("decode waiting approval state: %w", err)
		}
		waiting, _ := state["waiting"].(map[string]any)
		if waiting["kind"] != "approval" {
			if err := q.DeleteWakeup(ctx, node.ID); err != nil {
				return fmt.Errorf("clear mismatched approval wakeup: %w", err)
			}
			return nil
		}
		if timeoutState, present := waiting["timeoutState"]; present && timeoutState != nil {
			if err := q.DeleteWakeup(ctx, node.ID); err != nil {
				return fmt.Errorf("clear handled approval wakeup: %w", err)
			}
			return nil
		}
		deadlineAt, _ := waiting["deadlineAt"].(string)
		deadline := domain.ParseAbsoluteInstant(deadlineAt)
		if deadline == nil {
			return fmt.Errorf("waiting approval %q has invalid deadlineAt %q", node.ID, deadlineAt)
		}
		if !deadline.Equal(expectedWakeAt) {
			// A stale delivery must never apply a newer generation. Repair the
			// durable clock to the currently persisted generation instead.
			if err := q.UpsertWakeup(ctx, store.UpsertWakeupParams{
				RunNodeID: node.ID, WakeAt: deadline.UTC(), Reason: "approval_timeout",
			}); err != nil {
				return fmt.Errorf("re-arm current approval deadline: %w", err)
			}
			return nil
		}

		policy, _ := waiting["onTimeout"].(string)
		if policy == "escalate" {
			escalateTo := strings.TrimSpace(waitingString(waiting["escalateTo"]))
			if escalateTo != "" {
				previousAssignee := strings.TrimSpace(waitingString(waiting["assignee"]))
				escalatedAt := e.eventNow()
				nextWaiting := make(map[string]any, len(waiting)+4)
				maps.Copy(nextWaiting, waiting)
				nextWaiting["assignee"] = escalateTo
				nextWaiting["timeoutState"] = "escalated"
				nextWaiting["escalatedAt"] = escalatedAt.Format("2006-01-02T15:04:05.000Z")
				if previousAssignee != "" {
					nextWaiting["escalatedFrom"] = previousAssignee
				}
				nextState := make(map[string]any, len(state))
				maps.Copy(nextState, state)
				nextState["waiting"] = nextWaiting
				updated, err := q.EscalateWaitingApprovalDeadline(ctx, store.EscalateWaitingApprovalDeadlineParams{
					RunID: runID, NodeID: nodeID, ExpectedDeadlineAt: deadlineAt,
					StateJson: safePersist(nextState, stateJSONMaxBytes),
				})
				if err != nil {
					return fmt.Errorf("escalate waiting approval: %w", err)
				}
				if updated == 0 {
					return errSkipCommit
				}
				if err := q.DeleteWakeup(ctx, node.ID); err != nil {
					return fmt.Errorf("clear escalated approval wakeup: %w", err)
				}
				payload := map[string]any{
					"deadlineAt": deadlineAt, "assignee": escalateTo, "waiting": nextWaiting,
				}
				if previousAssignee != "" {
					payload["previousAssignee"] = previousAssignee
				}
				events.add(e.newID(), runID, nodeID, "approval.escalated",
					safePersist(payload, defaultPersistMaxBytes()), escalatedAt)
				applied = true
				return nil
			}
		}

		if policy != "auto_reject" {
			policy = "fail"
		}
		autoRejected := policy == "auto_reject"
		code := "approval_timed_out"
		reason := "Approval deadline expired"
		eventType := "approval.timed_out"
		if autoRejected {
			code = "approval_auto_rejected"
			reason = "Approval automatically rejected at deadline"
			eventType = "approval.auto_rejected"
		}
		errorPayload := map[string]any{
			"code": code, "reason": reason, "deadlineAt": deadlineAt, "onTimeout": policy,
		}
		failedAt := e.eventNow()
		failed, err := q.FailWaitingApprovalDeadline(ctx, store.FailWaitingApprovalDeadlineParams{
			RunID: runID, NodeID: nodeID, ExpectedDeadlineAt: deadlineAt,
			ErrorJson: safePersist(errorPayload, deadLetterErrorMaxBytes), FinishedAt: &failedAt,
		})
		if err != nil {
			return fmt.Errorf("fail waiting approval: %w", err)
		}
		if failed == 0 {
			return errSkipCommit
		}
		metricNodeCompletions.WithLabelValues("failed").Inc()
		if err := q.DeleteWakeup(ctx, node.ID); err != nil {
			return fmt.Errorf("clear failed approval wakeup: %w", err)
		}
		events.add(e.newID(), runID, nodeID, eventType, safePersist(map[string]any{
			"deadlineAt": deadlineAt, "onTimeout": policy, "error": errorPayload,
		}, defaultPersistMaxBytes()), failedAt)
		statuses, err := e.nodeStatuses(ctx, q, runID)
		if err != nil {
			return err
		}
		failedNodes := 0
		for _, status := range statuses {
			if status == "failed" {
				failedNodes++
			}
		}
		if err := e.flipRunTerminal(ctx, q, events, runID, "failed",
			map[string]any{"failedNodes": failedNodes}, failedAt, nil); err != nil {
			return err
		}
		applied = true
		return nil
	})
	return applied, err
}

func waitingString(value any) string {
	text, _ := value.(string)
	return text
}

// ResumeRun completes one still-waiting node and queues its downstream
// work, all in one transaction. Approval and wait_until keep the
// contract's historical empty output — the decision lives in the run
// timeline, never in the node output.
func (e *Engine) ResumeRun(ctx context.Context, runID, nodeID string) error {
	return e.ResumeRunWithInput(ctx, runID, nodeID, nil, "")
}

// Resume sentinel errors the API maps to the contract's wire shapes.
var (
	ErrResumeTokenRequired = errors.New("resumeToken is required")
	ErrInvalidResumeToken  = resumetoken.ErrInvalid
)

// ResumeRunWithInput completes one still-waiting node. A human_form node
// REQUIRES the signed resume token (bound to org/run/node/purpose) and
// validates the input against the node's declared JSON-schema subset —
// the validated input becomes the node output. A webhook node also captures
// its authenticated resume payload as output; other waiting kinds keep the
// historical empty output and ignore input/token. Only a
// still-`waiting` node completes (the CAS guard), so a replayed token
// cannot double-write output or double-enqueue downstream work.
func (e *Engine) ResumeRunWithInput(ctx context.Context, runID, nodeID string, input map[string]any, token string) error {
	finishedAt := e.eventNow()
	return e.inCompletionTx(ctx, runID, func(q *store.Queries, events *runEventBuffer) error {
		run, err := q.GetRunExecution(ctx, runID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("Run not found") //nolint:staticcheck // contract message is the wire contract
			}
			return fmt.Errorf("read run: %w", err)
		}
		wf, _, err := workflowFromRunInput(run.InputJson)
		if err != nil {
			return err
		}
		var target *domain.Node
		for index, node := range wf.Nodes {
			if node.ID == nodeID {
				target = &wf.Nodes[index]
				break
			}
		}
		if target == nil {
			return ErrResumeNodeNotFound
		}

		output := map[string]any{}
		if target.Type == "human_form" {
			if token == "" {
				return ErrResumeTokenRequired
			}
			if _, err := resumetoken.Verify(token, resumetoken.Binding{
				OrgID: run.OrgID, RunID: runID, NodeID: nodeID, Purpose: "human_form",
			}); err != nil {
				return err
			}
			schema := humanFormSchema(target.Config)
			if schema != nil {
				if problems := domain.ValidateInputValue(schema, input, "$"); len(problems) > 0 {
					return &InputValidationError{Errors: problems}
				}
			}
		}
		if target.Type == "human_form" || target.Type == "webhook" {
			maps.Copy(output, input)
		}

		rowID, err := q.MarkWaitingNodeSucceeded(ctx, store.MarkWaitingNodeSucceededParams{
			RunID: runID, NodeID: nodeID,
			StateJson:  safePersist(map[string]any{"output": output}, stateJSONMaxBytes),
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
		eventPayload := json.RawMessage(`{}`)
		if target.Type == "human_form" || target.Type == "webhook" {
			eventPayload = safePersist(map[string]any{"output": output}, defaultPersistMaxBytes())
		}
		events.add(e.newID(), runID, nodeID, "node.resumed", eventPayload, finishedAt)
		_, err = e.scheduleDownstream(ctx, q, events, ClaimedNode{RunID: runID, NodeID: nodeID}, finishedAt)
		return err
	})
}

// Waiting-sweep bounds: one poll tick keeps draining fair batches until the
// backlog empties or the per-sweep budget is spent, so a mass expiry
// (downtime window) recovers in few ticks without an unbounded tick.
const (
	waitingSweepBatchSize = 50
	waitingSweepMaxPerRun = 2_000
)

// processDueWaitingWakeups dispatches each durable clock by reason: timers
// resume downstream work, while approval deadlines apply their terminal or
// escalation policy. Batches remain run-fair and bounded under backlog.
func (e *Engine) processDueWaitingWakeups(ctx context.Context, q *store.Queries) int {
	processed := 0
	for processed < waitingSweepMaxPerRun {
		due, err := q.ListDueWaitingWakeups(ctx, waitingSweepBatchSize)
		if err != nil || len(due) == 0 {
			return processed
		}
		progressed := 0
		for _, wakeup := range due {
			if ctx.Err() != nil {
				return processed
			}
			switch wakeup.Reason {
			case "approval_timeout":
				applied, err := e.processApprovalTimeout(ctx, wakeup.RunID, wakeup.NodeID, wakeup.WakeAt)
				if err == nil {
					progressed++
					if applied {
						processed++
					}
				}
			case "wait_until":
				err := e.ResumeRun(ctx, wakeup.RunID, wakeup.NodeID)
				if err == nil {
					processed++
					progressed++
				} else if errors.Is(err, ErrResumeConflict) {
					// Another actor advanced it — the backlog still shrank.
					progressed++
				}
			}
			// Infrastructure/config errors leave the clock for the next sweep.
		}
		if progressed == 0 {
			// Nothing moved (persistent failures): stop instead of spinning
			// on the same head-of-line batch within this tick.
			return processed
		}
		if len(due) < waitingSweepBatchSize {
			return processed
		}
	}
	return processed
}

// humanFormSchema projects the node's config.schema into the domain's
// InputSchema subset for resume-time validation.
func humanFormSchema(config map[string]any) *domain.InputSchema {
	raw, ok := config["schema"].(map[string]any)
	if !ok {
		return nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var schema domain.InputSchema
	if err := json.Unmarshal(encoded, &schema); err != nil {
		return nil
	}
	if schema.Type == "" {
		schema.Type = "object"
	}
	return &schema
}
