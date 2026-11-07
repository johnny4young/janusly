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
	"maps"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/tokenhmac"
	"github.com/johnny4young/janusly/internal/tools"
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

// toolParamsDigest covers the rendered call with its resolved secrets and the
// identity and revision of any named credential, so repointing or rotating
// one changes the digest. It is keyed so the digest reveals none of them.
// It also returns the credential revision the integration must still find
// when it resolves the secret.
func toolParamsDigest(ctx context.Context, q *store.Queries, orgID, tool string, input map[string]any) (string, map[string]tools.CredentialRevision, error) {
	credentials := map[string]any{}
	pinned := map[string]tools.CredentialRevision{}
	if name, ok := input["credential"].(string); ok {
		row, err := q.GetCredentialByOrgName(ctx, store.GetCredentialByOrgNameParams{OrgID: orgID, Name: name})
		switch {
		case err == nil:
			credentials[name] = []any{row.ID, row.Kind, row.SecretRef, row.UpdatedAt.UTC().Format(time.RFC3339Nano)}
			pinned[name] = tools.CredentialRevision{ID: row.ID, UpdatedAt: row.UpdatedAt}
		case errors.Is(err, pgx.ErrNoRows):
			credentials[name] = nil
			pinned[name] = tools.CredentialRevision{} // absent: creating it later changes the call
		default:
			return "", nil, fmt.Errorf("read credential for tool approval: %w", err)
		}
	}
	raw, err := json.Marshal(map[string]any{"tool": tool, "input": input, "credentials": credentials})
	if err != nil {
		return "", nil, err
	}
	digest, err := tokenhmac.Digest("janusly.tool-approval.v1", raw)
	return digest, pinned, err
}

// maskedPaths lists where masking changed a value, so approvers know a hidden
// value is part of the call.
func maskedPaths(original, masked any, path string, out []string) []string {
	if len(out) >= 50 {
		return out
	}
	switch value := masked.(type) {
	case map[string]any:
		source, _ := original.(map[string]any)
		for _, key := range slices.Sorted(maps.Keys(value)) {
			out = maskedPaths(source[key], value[key], strings.TrimPrefix(path+"."+key, "."), out)
		}
	case []any:
		source, _ := original.([]any)
		for index, item := range value {
			var before any
			if index < len(source) {
				before = source[index]
			}
			out = maskedPaths(before, item, fmt.Sprintf("%s[%d]", path, index), out)
		}
	default:
		if !reflect.DeepEqual(original, masked) {
			out = append(out, path)
		}
	}
	return out
}

// gateToolCall runs immediately before the call, under the run's completion
// lock. It pauses on a missing or pending request, executes only after
// spending an approval whose digest matches, and otherwise fails. The digest,
// credential revision included, is computed under that lock.
func (e *Engine) gateToolCall(ctx context.Context, claim ClaimedNode, tool string, input map[string]any, redacted []string) (executors.Waiting, bool, map[string]tools.CredentialRevision, error) {
	masked := grammar.RedactSensitiveKeys(grammar.RedactValues(input, redacted))
	params, err := json.Marshal(map[string]any{"values": masked, "masked": maskedPaths(input, masked, "", []string{})})
	if err != nil || len(params) > toolApprovalParamsMaxBytes {
		return executors.Waiting{}, false, nil, toolApprovalError("TOOL_APPROVAL_UNREVIEWABLE", "Tool parameters are too large to review")
	}
	var waiting executors.Waiting
	paused := false
	var outcome error
	var pinned map[string]tools.CredentialRevision
	err = e.inCompletionTx(ctx, claim.RunID, func(q *store.Queries, _ *runEventBuffer) error {
		digest, revisions, err := toolParamsDigest(ctx, q, claim.OrgID, tool, input)
		if err != nil {
			outcome = toolApprovalError("TOOL_APPROVAL_UNREVIEWABLE", "Tool parameters cannot be bound to an approval")
			return errSkipCommit
		}
		pinned = revisions
		live, err := q.GetLiveToolApproval(ctx, store.GetLiveToolApprovalParams{RunID: claim.RunID, NodeID: claim.NodeID})
		if errors.Is(err, pgx.ErrNoRows) {
			requesters, err := q.ListToolApprovalRequesters(ctx, store.ListToolApprovalRequestersParams{
				RunID: claim.RunID, NodeID: claim.NodeID, MaxDepth: subworkflowDepthWalkerMax,
			})
			if err != nil {
				return fmt.Errorf("list tool approval requesters: %w", err)
			}
			eligible, err := eligibleApprovers(ctx, q, claim.OrgID, requesters)
			if err != nil {
				return err
			}
			live, err = q.InsertToolApproval(ctx, store.InsertToolApprovalParams{
				ID: e.newID(), OrgID: claim.OrgID, RunID: claim.RunID, NodeID: claim.NodeID, Tool: grammar.RedactString(tool, redacted),
				ParamsJson: params, ParamsDigest: digest, RequesterIds: requesters, EligibleApprovers: eligible,
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
		inTime, err := q.ConsumeToolApproval(ctx, live.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("tool approval %s was already spent", live.ID)
		} else if err != nil {
			return fmt.Errorf("consume tool approval: %w", err)
		}
		switch {
		case live.Status == ToolApprovalDenied:
			outcome = toolApprovalError("TOOL_APPROVAL_DENIED", "An approver denied this tool call")
		case live.Status != ToolApprovalApproved || !inTime.Bool:
			outcome = toolApprovalError("TOOL_APPROVAL_EXPIRED", "No approver decided before the request expired")
		case !hmac.Equal([]byte(live.ParamsDigest), []byte(digest)):
			outcome = toolApprovalError("TOOL_APPROVAL_PARAMS_CHANGED", "Tool parameters differ from the approved ones")
		}
		return nil
	})
	if err != nil {
		return executors.Waiting{}, false, nil, err
	}
	return waiting, paused, pinned, outcome
}

func toolApprovalWaiting(row store.ToolApprovalRequest) executors.Waiting {
	var params struct {
		Values any      `json:"values"`
		Masked []string `json:"masked"`
	}
	_ = json.Unmarshal(row.ParamsJson, &params)
	deadline := row.ExpiresAt.UTC()
	metadata := map[string]any{
		"kind": "tool_approval", "approvalId": row.ID, "tool": row.Tool,
		"params": params.Values, "maskedPaths": params.Masked, "paramsDigest": row.ParamsDigest, "requiredApprovals": 1,
		"requesterIds": row.RequesterIds, "deadlineAt": deadline.Format("2006-01-02T15:04:05.000Z"),
	}
	if row.EligibleApprovers.Valid {
		metadata["eligibleApprovers"] = row.EligibleApprovers.Int32
	}
	return executors.Waiting{Reason: "Waiting for human approval", Metadata: metadata, WakeAt: &deadline}
}

// eligibleApprovers counts members who may decide: they can start runs and
// did not cause this execution. An org without member rows (local headers
// mode) reports unknown rather than nobody.
func eligibleApprovers(ctx context.Context, q *store.Queries, orgID string, requesters []string) (pgtype.Int4, error) {
	members, err := q.ListOrgMembers(ctx, orgID)
	if err != nil {
		return pgtype.Int4{}, fmt.Errorf("list members for tool approval: %w", err)
	}
	if len(members) == 0 {
		return pgtype.Int4{}, nil
	}
	canDecide := map[string]bool{}
	count := int32(0)
	for _, member := range members {
		if slices.Contains(requesters, member.UserID) {
			continue
		}
		allowed, seen := canDecide[member.Role]
		if !seen {
			role, err := auth.ResolveRoleFromMembership(ctx, q, orgID, member.Role, auth.ModeSupabase)
			if err != nil {
				return pgtype.Int4{}, err
			}
			if role != nil && auth.Rank[role.InheritsFrom] >= auth.Rank[auth.RoleEditor] {
				permissions, err := auth.EffectivePermissions(ctx, q, orgID, role)
				if err != nil {
					return pgtype.Int4{}, err
				}
				allowed = permissions["runs.start"]
			}
			canDecide[member.Role] = allowed
		}
		if allowed {
			count++
		}
	}
	return pgtype.Int4{Int32: count, Valid: true}, nil
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
	events.add(newEventID(), row.RunID, row.NodeID, eventType,
		safePersist(map[string]any{"approvalId": row.ID, "tool": row.Tool}, e.persistence.MaxBytes()), e.eventNow())
	if err := q.NotifyWake(ctx, store.NotifyWakeParams{RunID: row.RunID, Ready: 1}); err != nil {
		return fmt.Errorf("notify tool approval wake: %w", err)
	}
	return nil
}

// toolApprovalPolicy reads the org's listed tools. Unlike ordinary settings
// it fails closed: an unreadable or malformed policy stops the step.
func (e *Engine) toolApprovalPolicy(ctx context.Context, orgID string) (map[string]bool, error) {
	raw, err := store.New(e.pool).GetOrgConfigValue(ctx, store.GetOrgConfigValueParams{OrgID: orgID, Key: orgconfig.ToolApprovalPolicyKey})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("read tool approval policy: %w", err)
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return nil, fmt.Errorf("tool approval policy is not a string")
	}
	return orgconfig.ParseToolApprovalPolicy(text)
}

// ApprovalActorID is who acted, for tool-approval purposes. A service token's
// user id is a free-form header, so its actions count as the token itself.
func ApprovalActorID(actor *auth.Context) string {
	if actor == nil {
		return ""
	}
	if actor.Mode == auth.ModeServiceToken {
		return "service-token:" + actor.ServiceTokenSuffix
	}
	return actor.UserID
}

// recordRunActor bars actor from approving the calls their action affects.
func recordRunActor(ctx context.Context, q *store.Queries, runID, nodeID, role, actor string) error {
	if actor == "" {
		return nil
	}
	if err := q.RecordRunActor(ctx, store.RecordRunActorParams{RunID: runID, NodeID: nodeID, Role: role, Actor: actor}); err != nil {
		return fmt.Errorf("record %s actor: %w", role, err)
	}
	return nil
}
