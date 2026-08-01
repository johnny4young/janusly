// The waiting lifecycle: a node pauses (approval, wait_until), the run stays
// running, and resumption — human or timer — completes the still-waiting
// node with the compare-and-set the whole engine relies on, so a duplicate
// resume can never double-write output or double-queue downstream work.
package engine

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"encoding/json"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/orgconfig"
	"github.com/johnny4young/janusly/go/internal/resumetoken"
	"github.com/johnny4young/janusly/go/internal/store"
	"time"
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
	checkpointAt := eventNow()
	metadata := map[string]any{}
	if waiting.Reason != "" {
		metadata["reason"] = waiting.Reason
	}
	for key, value := range waiting.Metadata {
		metadata[key] = value
	}
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
	metadata["waitingSince"] = checkpointAt.Format("2006-01-02T15:04:05.000Z")
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
	return e.ResumeRunWithInput(ctx, runID, nodeID, nil, "")
}

// Resume sentinel errors the API maps to the reference's wire shapes.
var (
	ErrResumeTokenRequired = errors.New("resumeToken is required")
	ErrInvalidResumeToken  = resumetoken.ErrInvalid
)

// ResumeRunWithInput completes one still-waiting node. A human_form node
// REQUIRES the signed resume token (bound to org/run/node/purpose) and
// validates the input against the node's declared JSON-schema subset —
// the validated input becomes the node output. Other waiting kinds keep
// the historical empty output and ignore input/token. Only a
// still-`waiting` node completes (the CAS guard), so a replayed token
// cannot double-write output or double-enqueue downstream work.
func (e *Engine) ResumeRunWithInput(ctx context.Context, runID, nodeID string, input map[string]any, token string) error {
	finishedAt := eventNow()
	return e.inCompletionTx(ctx, runID, func(q *store.Queries, events *runEventBuffer) error {
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
			for key, value := range input {
				output[key] = value
			}
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
		events.add(e.newID(), runID, nodeID, "node.resumed", []byte(`{}`), finishedAt)
		return e.scheduleDownstream(ctx, q, events, runID, finishedAt)
	})
}

// Timer-sweep bounds: one poll tick keeps draining fair batches until the
// backlog empties or the per-sweep budget is spent, so a mass expiry
// (downtime window) recovers in few ticks without an unbounded tick.
const (
	timerSweepBatchSize = 50
	timerSweepMaxPerRun = 2_000
)

// resumeDueTimers auto-completes every waiting node whose wake-up clock has
// passed — the wait_until firing path. Batches are run-fair (round-robin by
// run) and the drain loop continues past one batch under backlog. A
// conflict means another actor (manual resume, cancellation) advanced the
// node first; that is the idempotency contract, not an error.
func (e *Engine) resumeDueTimers(ctx context.Context, q *store.Queries) int {
	resumed := 0
	for resumed < timerSweepMaxPerRun {
		due, err := q.ListDueWaitingWakeups(ctx, timerSweepBatchSize)
		if err != nil || len(due) == 0 {
			return resumed
		}
		progressed := 0
		for _, timer := range due {
			if ctx.Err() != nil {
				return resumed
			}
			err := e.ResumeRun(ctx, timer.RunID, timer.NodeID)
			if err == nil {
				resumed++
				progressed++
				continue
			}
			if errors.Is(err, ErrResumeConflict) {
				// Another actor advanced it — the backlog still shrank.
				progressed++
			}
			// Other errors leave the wake-up in place for the next sweep.
		}
		if progressed == 0 {
			// Nothing moved (persistent failures): stop instead of spinning
			// on the same head-of-line batch within this tick.
			return resumed
		}
		if len(due) < timerSweepBatchSize {
			return resumed
		}
	}
	return resumed
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
