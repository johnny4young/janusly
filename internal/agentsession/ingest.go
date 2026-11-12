// Package agentsession stores and projects external agent sessions reported
// through the hooks bridge.
package agentsession

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	// MaxLiveSessionsPerClient bounds the running sessions one client keeps.
	MaxLiveSessionsPerClient = 50
	// MaxEventsPerSession truncates a session; only closing events follow.
	MaxEventsPerSession = 5000
	// closingSlack bounds the closing and stale events a full session may still store.
	closingSlack = 50
	// MaxStoredPerSession is every receipt a session can hold.
	MaxStoredPerSession = MaxEventsPerSession + closingSlack
	// IdleAfter is how long a running session may stay silent.
	IdleAfter = 30 * time.Minute
	// StaleAfter keeps late events of an ended session out of its projection.
	StaleAfter = time.Hour
	// Retention is how long a session outlives its last event.
	Retention = 14 * 24 * time.Hour
)

// Outcomes of one ingest.
const (
	OutcomeApplied   = "applied"
	OutcomeStale     = "stale"
	OutcomeDuplicate = "duplicate"
)

var (
	// ErrLiveLimit refuses a new session past MaxLiveSessionsPerClient.
	ErrLiveLimit = errors.New("the agent client holds the most live sessions it may")
	// ErrTruncated refuses non-closing events once a session is full.
	ErrTruncated = errors.New("the agent session holds the most events it may keep")
)

// Result says what one ingest stored.
type Result struct {
	SessionID string
	Outcome   string
	// PriorOutcome is the original receipt's outcome for a duplicate.
	PriorOutcome string
}

// errReceiptRace means the same event id landed concurrently under another
// session; the retry answers it as a duplicate.
var errReceiptRace = errors.New("agent session receipt raced")

// Ingest records one verified event for the principal's client in one
// transaction. The session row lock keeps seq dense and receipts unique.
func Ingest(ctx context.Context, pool *pgxpool.Pool, principal *agentclient.Principal, event hookwire.Event, now time.Time, newID func() string) (Result, error) {
	result, err := ingest(ctx, pool, principal, event, now, newID)
	if errors.Is(err, errReceiptRace) {
		return ingest(ctx, pool, principal, event, now, newID)
	}
	return result, err
}

func ingest(ctx context.Context, pool *pgxpool.Pool, principal *agentclient.Principal, event hookwire.Event, now time.Time, newID func() string) (Result, error) {
	now = now.UTC()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)

	session, err := lockOrCreate(ctx, q, principal, event, now, newID)
	if err != nil {
		return Result{}, err
	}
	receipt, err := q.GetAgentSessionReceipt(ctx, store.GetAgentSessionReceiptParams{
		AgentClientID: principal.ClientID, EventID: event.ID,
	})
	if err == nil {
		return Result{SessionID: receipt.SessionID, Outcome: OutcomeDuplicate, PriorOutcome: receipt.Outcome}, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}

	params := eventParams(principal, session.ID, event, now, newID())
	stale := session.EndedAt != nil && now.Sub(*session.EndedAt) > StaleAfter
	switch {
	case session.EventCount >= MaxStoredPerSession:
		return Result{}, ErrTruncated
	case stale:
		params.Outcome = OutcomeStale
		if err := q.CountAgentSessionReceipt(ctx, store.CountAgentSessionReceiptParams{OrgID: principal.OrgID, ID: session.ID}); err != nil {
			return Result{}, err
		}
	case session.Truncated && !hookwire.Closing(event.Type):
		return Result{}, ErrTruncated
	default:
		seq, err := q.ProjectAgentSessionEvent(ctx, projectParams(principal.OrgID, session.ID, event, now))
		if err != nil {
			return Result{}, err
		}
		params.Outcome, params.Seq = OutcomeApplied, pgtype.Int8{Int64: seq, Valid: true}
	}
	inserted, err := q.InsertAgentSessionEvent(ctx, params)
	if err != nil {
		return Result{}, err
	}
	if inserted == 0 {
		return Result{}, errReceiptRace
	}
	return Result{SessionID: session.ID, Outcome: params.Outcome}, tx.Commit(ctx)
}

func lockOrCreate(ctx context.Context, q *store.Queries, principal *agentclient.Principal, event hookwire.Event, now time.Time, newID func() string) (store.AgentSession, error) {
	// Session ids are namespaced per client: no client can claim or probe another's.
	lookup := store.LockAgentSessionByExternalParams{
		OrgID: principal.OrgID, AgentClientID: principal.ClientID, ExternalSessionID: event.Data.SessionID,
	}
	session, err := q.LockAgentSessionByExternal(ctx, lookup)
	if !errors.Is(err, pgx.ErrNoRows) {
		return session, err
	}
	if err := q.LockAgentClientSessions(ctx, principal.ClientID); err != nil {
		return session, err
	}
	live, err := q.CountLiveAgentSessions(ctx, store.CountLiveAgentSessionsParams{
		AgentClientID: principal.ClientID, IdleBefore: now.Add(-IdleAfter),
	})
	if err != nil {
		return session, err
	}
	if live >= MaxLiveSessionsPerClient {
		return session, ErrLiveLimit
	}
	session, err = q.InsertAgentSession(ctx, store.InsertAgentSessionParams{
		ID: newID(), OrgID: principal.OrgID, AgentClientID: principal.ClientID,
		ExternalSessionID: event.Data.SessionID, Runtime: event.Runtime(), At: now,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// A concurrent first event created it; wait for that row.
		return q.LockAgentSessionByExternal(ctx, lookup)
	}
	return session, err
}

func projectParams(orgID, sessionID string, event hookwire.Event, now time.Time) store.ProjectAgentSessionEventParams {
	d := event.Data
	ends := event.Type == hookwire.TypeSessionEnded
	return store.ProjectAgentSessionEventParams{
		OrgID: orgID, ID: sessionID, At: now, MaxEvents: MaxEventsPerSession,
		Project: text(d.Project), RuntimeVersion: text(d.RuntimeVersion), Model: text(d.Model),
		Ends: ends, EndStatus: text(map[bool]string{true: d.Status}[ends]),
	}
}

func eventParams(principal *agentclient.Principal, sessionID string, event hookwire.Event, now time.Time, id string) store.InsertAgentSessionEventParams {
	d := event.Data
	params := store.InsertAgentSessionEventParams{
		ID: id, OrgID: principal.OrgID, AgentClientID: principal.ClientID, SessionID: sessionID,
		EventID: event.ID, Type: event.Type,
		AgentID: text(d.AgentID), ParentAgentID: text(d.ParentAgentID), AgentType: text(d.AgentType),
		ToolUseID: text(d.ToolUseID), Tool: text(d.Tool), ToolKind: text(d.ToolKind), McpServer: text(d.MCPServer),
		Status: text(d.Status), OccurredAt: event.Time.UTC(), ReceivedAt: now,
	}
	if d.DurationMs != nil {
		params.DurationMs = pgtype.Int8{Int64: *d.DurationMs, Valid: true}
	}
	if d.JanuslyRefs != nil && *d.JanuslyRefs != (hookwire.Refs{}) {
		params.JanuslyRefs, _ = json.Marshal(d.JanuslyRefs)
	}
	return params
}

func text(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}
