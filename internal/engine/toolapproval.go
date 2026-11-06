// Tool-level approval: a tool node marked requireApproval pauses at its call
// site and runs only on an unspent human approval bound to the exact
// parameters it will execute with.
package engine

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/tokenhmac"
)

// Decisions an approver may record.
const (
	ToolApprovalApproved = "approved"
	ToolApprovalDenied   = "denied"
)

const toolApprovalParamsMaxBytes = 64_000

var (
	ErrToolApprovalNotFound = errors.New("Tool approval not found")                                  //nolint:staticcheck // wire message
	ErrToolApprovalSelf     = errors.New("You cannot decide a tool call from a run you started")     //nolint:staticcheck // wire message
	ErrToolApprovalConflict = errors.New("Tool approval is no longer pending")                       //nolint:staticcheck // wire message
	ErrToolApprovalStale    = errors.New("Tool approval does not match the parameters you reviewed") //nolint:staticcheck // wire message
)

func toolApprovalError(code, message string) *ExecError {
	return &ExecError{Name: "ToolApprovalError", Code: code, Message: message}
}

// toolParamsDigest covers the rendered call, resolved secrets included, keyed
// so the digest shown to approvers cannot be used to guess those values.
func toolParamsDigest(tool string, input map[string]any) (string, error) {
	raw, err := json.Marshal(map[string]any{"tool": tool, "input": input})
	if err != nil {
		return "", err
	}
	return tokenhmac.Digest("janusly.tool-approval.v1", raw)
}

// gateToolApproval runs immediately before the call, under the run's
// completion lock. It pauses on a missing or pending request, executes only
// after spending an approval whose digest matches, and otherwise fails.
func (e *Engine) gateToolApproval(ctx context.Context, claim ClaimedNode, tool string, input map[string]any, redacted []string) (executors.Waiting, bool, error) {
	digest, err := toolParamsDigest(tool, input)
	if err != nil {
		return executors.Waiting{}, false, toolApprovalError("TOOL_APPROVAL_UNREVIEWABLE", "Tool parameters cannot be bound to an approval")
	}
	params, err := json.Marshal(grammar.RedactSensitiveKeys(grammar.RedactValues(input, redacted)))
	if err != nil || len(params) > toolApprovalParamsMaxBytes {
		return executors.Waiting{}, false, toolApprovalError("TOOL_APPROVAL_UNREVIEWABLE", "Tool parameters are too large to review")
	}
	var waiting executors.Waiting
	paused := false
	var outcome error
	err = e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries, _ *runEventBuffer) error {
		live, err := q.GetLiveToolApproval(ctx, store.GetLiveToolApprovalParams{RunID: claim.RunID, NodeID: claim.NodeID})
		if errors.Is(err, pgx.ErrNoRows) {
			requesters, err := q.ListToolApprovalRequesters(ctx, claim.RunID)
			if err != nil {
				return fmt.Errorf("list tool approval requesters: %w", err)
			}
			live, err = q.InsertToolApproval(ctx, store.InsertToolApprovalParams{
				ID: e.newID(), OrgID: claim.OrgID, RunID: claim.RunID, NodeID: claim.NodeID, Tool: grammar.RedactString(tool, redacted),
				ParamsJson: params, ParamsDigest: digest, RequesterIds: requesters,
			})
			if err != nil {
				return fmt.Errorf("insert tool approval: %w", err)
			}
		} else if err != nil {
			return fmt.Errorf("read tool approval: %w", err)
		}
		if live.Status == "pending" {
			expired, err := q.ExpireToolApproval(ctx, live.ID)
			if err != nil {
				return fmt.Errorf("expire tool approval: %w", err)
			}
			if expired == 0 {
				waiting, paused = toolApprovalWaiting(live), true
				return nil
			}
			live.Status = "expired"
		}
		consumed, err := q.ConsumeToolApproval(ctx, live.ID)
		if err != nil {
			return fmt.Errorf("consume tool approval: %w", err)
		}
		if consumed != 1 {
			return fmt.Errorf("tool approval %s was already spent", live.ID)
		}
		switch {
		case live.Status == ToolApprovalDenied:
			outcome = toolApprovalError("TOOL_APPROVAL_DENIED", "An approver denied this tool call")
		case live.Status != ToolApprovalApproved:
			outcome = toolApprovalError("TOOL_APPROVAL_EXPIRED", "No approver decided before the request expired")
		case !hmac.Equal([]byte(live.ParamsDigest), []byte(digest)):
			outcome = toolApprovalError("TOOL_APPROVAL_PARAMS_CHANGED", "Tool parameters differ from the approved ones")
		}
		return nil
	})
	if err != nil {
		return executors.Waiting{}, false, err
	}
	return waiting, paused, outcome
}

func toolApprovalWaiting(row store.ToolApprovalRequest) executors.Waiting {
	var params any
	_ = json.Unmarshal(row.ParamsJson, &params)
	deadline := row.ExpiresAt.UTC()
	return executors.Waiting{
		Reason: "Waiting for human approval",
		Metadata: map[string]any{
			"kind": "tool_approval", "approvalId": row.ID, "tool": row.Tool,
			"params": params, "paramsDigest": row.ParamsDigest, "requiredApprovals": 1,
			"deadlineAt": deadline.Format("2006-01-02T15:04:05.000Z"),
		},
		WakeAt: &deadline,
	}
}

// ToolApprovalDecision is one approver's answer to one request.
type ToolApprovalDecision struct {
	OrgID, ApprovalID, Actor, ParamsDigest, Status string
}

// DecideToolApproval records a decision and hands the step back to the
// queue, where the gate runs or fails it. Repeating one's own decision is a
// no-op reported as replayed.
func (e *Engine) DecideToolApproval(ctx context.Context, in ToolApprovalDecision) (store.ToolApprovalRequest, bool, error) {
	if in.Actor == "" || (in.Status != ToolApprovalApproved && in.Status != ToolApprovalDenied) {
		return store.ToolApprovalRequest{}, false, ErrToolApprovalConflict
	}
	row, err := store.New(e.pool).GetToolApprovalForOrg(ctx, store.GetToolApprovalForOrgParams{ID: in.ApprovalID, OrgID: in.OrgID})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, false, ErrToolApprovalNotFound
	} else if err != nil {
		return row, false, fmt.Errorf("read tool approval: %w", err)
	}
	replayed := false
	err = e.inCompletionTx(ctx, row.RunID, func(q *store.Queries, events *runEventBuffer) error {
		current, err := q.GetToolApprovalForOrg(ctx, store.GetToolApprovalForOrgParams{ID: in.ApprovalID, OrgID: in.OrgID})
		if err != nil {
			return fmt.Errorf("lock tool approval: %w", err)
		}
		row = current
		if slices.Contains(row.RequesterIds, in.Actor) {
			return ErrToolApprovalSelf
		}
		if row.Status == in.Status && row.DecidedBy.String == in.Actor {
			replayed = true
			return errSkipCommit
		}
		if row.ParamsDigest != in.ParamsDigest {
			return ErrToolApprovalStale
		}
		decided, err := q.DecideToolApproval(ctx, store.DecideToolApprovalParams{
			Status: in.Status, Actor: in.Actor, ID: row.ID, OrgID: in.OrgID, ParamsDigest: in.ParamsDigest,
		})
		if err != nil {
			return fmt.Errorf("decide tool approval: %w", err)
		}
		if decided == 0 {
			return ErrToolApprovalConflict
		}
		return e.requeueToolApproval(ctx, q, events, row, "tool_approval."+in.Status)
	})
	return row, replayed, err
}

// expireToolApproval settles a request nobody decided in time; the step then
// passes through the gate, which spends the expiry and fails.
func (e *Engine) expireToolApproval(ctx context.Context, runID, nodeID string) (bool, error) {
	return e.inCompletionTxCommitted(ctx, runID, func(q *store.Queries, events *runEventBuffer) error {
		live, err := q.GetLiveToolApproval(ctx, store.GetLiveToolApprovalParams{RunID: runID, NodeID: nodeID})
		if errors.Is(err, pgx.ErrNoRows) {
			return errSkipCommit
		} else if err != nil {
			return fmt.Errorf("read tool approval: %w", err)
		}
		if expired, err := q.ExpireToolApproval(ctx, live.ID); err != nil || expired == 0 {
			if err != nil {
				return fmt.Errorf("expire tool approval: %w", err)
			}
			return errSkipCommit
		}
		if err := e.requeueToolApproval(ctx, q, events, live, "tool_approval.expired"); errors.Is(err, ErrToolApprovalConflict) {
			return errSkipCommit
		} else if err != nil {
			return err
		}
		return nil
	})
}

func (e *Engine) requeueToolApproval(ctx context.Context, q *store.Queries, events *runEventBuffer, row store.ToolApprovalRequest, eventType string) error {
	rowID, err := q.RequeueToolApprovalNode(ctx, store.RequeueToolApprovalNodeParams{
		RunID: row.RunID, NodeID: row.NodeID, ApprovalID: row.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrToolApprovalConflict
	} else if err != nil {
		return fmt.Errorf("requeue tool approval step: %w", err)
	}
	if err := q.DeleteWakeup(ctx, rowID); err != nil {
		return fmt.Errorf("clear tool approval wakeup: %w", err)
	}
	events.scope(row.OrgID)
	events.add(e.newID(), row.RunID, row.NodeID, eventType,
		safePersist(map[string]any{"approvalId": row.ID, "tool": row.Tool}, e.persistence.MaxBytes()), e.eventNow())
	if err := q.NotifyWake(ctx, store.NotifyWakeParams{RunID: row.RunID, Ready: 1}); err != nil {
		return fmt.Errorf("notify tool approval wake: %w", err)
	}
	return nil
}
