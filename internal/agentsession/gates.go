package agentsession

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/signedingest"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	// MaxOpenGatesPerClient bounds pending gates; past it the call goes back to the runtime's own prompt.
	MaxOpenGatesPerClient = 20
	// A gate lives as long as its bridge waits, within these bounds: nobody
	// should decide a call no hook is holding any more.
	minGateTTL     = 30 * time.Second
	defaultGateTTL = 2 * time.Minute
	maxGateTTL     = 10 * time.Minute
	// approvalWindow is how long an approval answers "allow" after it is given.
	approvalWindow = 2 * time.Minute
	// GateContentRetention is how long captured input outlives its gate.
	GateContentRetention = 7 * 24 * time.Hour
	maxGateContentBytes  = 8000
)

var (
	// ErrNotGated refuses a gate for a tool outside the client's gateTools.
	ErrNotGated = errors.New("this tool is not in the agent client's gateTools")
	// ErrGateSession refuses a gate for a session the client never reported.
	ErrGateSession = errors.New("agent session not found")
	// ErrGateContent refuses captured input from a client that does not capture content.
	ErrGateContent = errors.New("this agent client does not capture content")
	// ErrGateNotFound hides another client's gate.
	ErrGateNotFound = errors.New("gate not found")
)

// GateDecision maps a stored status to what the hook prints. An expired gate
// is "ask": never an allow by default.
func GateDecision(status string) string {
	switch status {
	case "approved":
		return hookwire.DecisionAllow
	case "denied":
		return hookwire.DecisionDeny
	case "pending":
		return hookwire.DecisionPending
	}
	return hookwire.DecisionAsk
}

// OpenGate records a held tool call for the principal's client, or returns the
// gate that call already has.
func OpenGate(ctx context.Context, pool *pgxpool.Pool, principal *agentclient.Principal, request hookwire.GateRequest, now time.Time, newID func() string) (hookwire.GateReply, error) {
	if !agentclient.GateMatches(principal.GateTools, request.Tool) {
		return hookwire.GateReply{}, ErrNotGated
	}
	if request.Content != nil && !principal.CaptureContent {
		return hookwire.GateReply{}, ErrGateContent
	}
	now = now.UTC()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return hookwire.GateReply{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	sessionID, err := q.GetAgentSessionByExternal(ctx, store.GetAgentSessionByExternalParams{
		OrgID: principal.OrgID, AgentClientID: principal.ClientID, ExternalSessionID: request.SessionID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return hookwire.GateReply{}, ErrGateSession
	}
	if err != nil {
		return hookwire.GateReply{}, err
	}
	call := store.GetAgentGateByCallParams{SessionID: sessionID, ToolUseID: request.ToolUseID}
	if existing, err := q.GetAgentGateByCall(ctx, call); err == nil {
		return sameCall(existing, request, now), tx.Commit(ctx)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return hookwire.GateReply{}, err
	}
	if err := q.LockAgentClientSessions(ctx, principal.ClientID); err != nil {
		return hookwire.GateReply{}, err
	}
	if err := q.ExpireAgentGatesForClient(ctx, store.ExpireAgentGatesForClientParams{AgentClientID: principal.ClientID, Now: now}); err != nil {
		return hookwire.GateReply{}, err
	}
	open, err := q.CountPendingAgentGates(ctx, principal.ClientID)
	if err != nil {
		return hookwire.GateReply{}, err
	}
	if open >= MaxOpenGatesPerClient {
		return hookwire.GateReply{Decision: hookwire.DecisionAsk}, tx.Commit(ctx)
	}
	var content json.RawMessage
	if request.Content != nil {
		content = grammar.SafePersistPayload(signedingest.Scrub(map[string]any{"input": request.Content.Input}),
			grammar.PersistOptions{MaxBytes: grammar.PersistUnbounded})
		// Input that does not fit is stored as not captured: the decider must
		// never read a cut-off argument as the whole call.
		if len(content) > maxGateContentBytes {
			content = nil
		}
	}
	gate, err := q.InsertAgentGate(ctx, store.InsertAgentGateParams{
		ID: newID(), OrgID: principal.OrgID, AgentClientID: principal.ClientID, SessionID: sessionID,
		ToolUseID: request.ToolUseID, Tool: request.Tool, McpServer: text(request.MCPServer), AgentID: text(request.AgentID),
		Content: content, ExpiresAt: now.Add(gateTTL(request.WaitSeconds)),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// The same call raced in; answer with its gate.
		existing, err := q.GetAgentGateByCall(ctx, call)
		if err != nil {
			return hookwire.GateReply{}, err
		}
		return sameCall(existing, request, now), tx.Commit(ctx)
	}
	if err != nil {
		return hookwire.GateReply{}, err
	}
	return gateReply(gate, now), tx.Commit(ctx)
}

func gateTTL(waitSeconds int) time.Duration {
	if waitSeconds <= 0 {
		return defaultGateTTL
	}
	return min(max(time.Duration(waitSeconds)*time.Second, minGateTTL), maxGateTTL)
}

func gateReply(gate store.AgentSessionGate, now time.Time) hookwire.GateReply {
	return hookwire.GateReply{GateID: gate.ID, Decision: liveDecision(gate.Status, gate.ExpiresAt, gate.DecidedAt, now), Reason: gate.Reason.String}
}

// sameCall answers a repeated open with the stored gate only when it names
// the same tool: a decision never carries over to another call.
func sameCall(gate store.AgentSessionGate, request hookwire.GateRequest, now time.Time) hookwire.GateReply {
	if gate.Tool != request.Tool || gate.McpServer.String != request.MCPServer {
		return hookwire.GateReply{Decision: hookwire.DecisionAsk}
	}
	return gateReply(gate, now)
}

// liveDecision never lets a decision outlive its moment: an unanswered gate
// past its expiry, and an approval older than approvalWindow, are "ask".
func liveDecision(status string, expiresAt time.Time, decidedAt *time.Time, now time.Time) string {
	switch {
	case status == "pending" && !now.Before(expiresAt):
		return hookwire.DecisionAsk
	case status == "approved" && (decidedAt == nil || now.Sub(*decidedAt) > approvalWindow):
		return hookwire.DecisionAsk
	}
	return GateDecision(status)
}

// ReadGate is the agent's poll: only its own client's gate.
func ReadGate(ctx context.Context, pool *pgxpool.Pool, principal *agentclient.Principal, gateID string, now time.Time) (hookwire.GateReply, error) {
	gate, err := store.New(pool).GetAgentGateForClient(ctx, store.GetAgentGateForClientParams{
		OrgID: principal.OrgID, AgentClientID: principal.ClientID, ID: gateID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return hookwire.GateReply{}, ErrGateNotFound
	}
	if err != nil {
		return hookwire.GateReply{}, err
	}
	return hookwire.GateReply{GateID: gate.ID, Decision: liveDecision(gate.Status, gate.ExpiresAt, gate.DecidedAt, now.UTC()), Reason: gate.Reason.String}, nil
}
