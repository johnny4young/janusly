package sessiondraft

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/publishgate"
	"github.com/johnny4young/janusly/internal/store"
)

// ConvertedAction audits a session turned into a draft.
const ConvertedAction = "agent_session.converted"

func init() { audit.RegisterRuntimeAction(ConvertedAction) }

// View is the wire shape both entry points return.
func View(saved SavedDraft, next string) map[string]any {
	servers := saved.Built.MCPServers
	if servers == nil {
		servers = []string{}
	}
	return map[string]any{
		"draftId": saved.Draft.ID, "workflowId": saved.Draft.WorkflowID, "digest": saved.Draft.Digest,
		"conversion": saved.Conversion, "agents": saved.Built.Agents, "mcpServers": servers,
		"placeholders": saved.Built.Placeholders, "next": next,
	}
}

// ErrSessionNotFound answers a missing session, one of another organization
// and, for an agent, one of another client alike.
var ErrSessionNotFound = errors.New("agent session not found")

// SaveInput says who converts which session.
type SaveInput struct {
	OrgID     string
	SessionID string
	// CreatedBy is the draft's author: a person, or "agent:<client id>".
	CreatedBy string
	// OnlyClientID, when set, limits the conversion to that client's sessions.
	OnlyClientID string
	NewID        func() string
	Catalog      authoring.McpCatalogSource
}

// SavedDraft is a stored draft with what the conversion kept and left open.
type SavedDraft struct {
	Draft      store.WorkflowDraft
	Conversion Conversion
	Built      Draft
	Checks     []publishgate.Check
	Unchanged  bool
}

// LoadEvents reads a session's applied events in order.
func LoadEvents(ctx context.Context, q *store.Queries, orgID, sessionID string) ([]agentsession.EventRow, error) {
	rows, err := q.ListAgentSessionEvents(ctx, store.ListAgentSessionEventsParams{
		OrgID: orgID, SessionID: sessionID, RowLimit: agentsession.MaxStoredPerSession,
	})
	if err != nil {
		return nil, err
	}
	events := make([]agentsession.EventRow, 0, len(rows))
	for _, event := range rows {
		row := agentsession.EventRow{
			Seq: event.Seq.Int64, Type: event.Type, AgentID: event.AgentID.String, ParentAgentID: event.ParentAgentID.String,
			AgentType: event.AgentType.String, Tool: event.Tool.String, ToolKind: event.ToolKind.String,
			MCPServer: event.McpServer.String, Status: event.Status.String, Refs: event.JanuslyRefs, At: event.OccurredAt,
		}
		if event.DurationMs.Valid {
			row.DurationMs = &event.DurationMs.Int64
		}
		events = append(events, row)
	}
	return events, nil
}

// SaveDraft converts an observed session into a draft of a new workflow. The
// draft is an ordinary one: it never runs or publishes by itself, and its
// placeholders keep it from qualifying until they are filled in.
func SaveDraft(ctx context.Context, pool *pgxpool.Pool, in SaveInput) (SavedDraft, error) {
	q := store.New(pool)
	session, err := q.GetAgentSession(ctx, store.GetAgentSessionParams{OrgID: in.OrgID, ID: in.SessionID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && in.OnlyClientID != "" && session.AgentClientID != in.OnlyClientID) {
		return SavedDraft{}, ErrSessionNotFound
	}
	if err != nil {
		return SavedDraft{}, err
	}
	events, err := LoadEvents(ctx, q, in.OrgID, session.ID)
	if err != nil {
		return SavedDraft{}, err
	}
	name := "Observed session"
	if session.Project.Valid && session.Project.String != "" {
		name = "Observed session in " + session.Project.String
	}
	built, err := BuildDraft("wf_"+in.NewID(), name, events)
	if err != nil {
		return SavedDraft{}, err
	}
	raw, err := json.Marshal(built.Document)
	if err != nil {
		return SavedDraft{}, err
	}
	wf, _ := domain.Parse(raw)
	if wf == nil {
		return SavedDraft{}, errors.New("drafted workflow does not parse")
	}
	document, err := domain.CanonicalWorkflowDocument(wf)
	if err != nil {
		return SavedDraft{}, err
	}
	fixtures := []publishgate.Fixture{}
	digest, err := publishgate.Digest("", document, fixtures)
	if err != nil {
		return SavedDraft{}, err
	}
	var parsed map[string]any
	if err := json.Unmarshal(document, &parsed); err != nil {
		return SavedDraft{}, err
	}
	origin, _ := json.Marshal(map[string]any{"kind": "observed_session", "sessionId": session.ID})
	saved := SavedDraft{
		Conversion: Convertibility(events), Built: built,
		Checks: publishgate.StaticChecks(wf, parsed, fixtures, authoring.NewBuilder(pool, in.Catalog).Build(ctx, in.OrgID)),
	}
	saved.Draft, err = q.InsertWorkflowDraft(ctx, store.InsertWorkflowDraftParams{
		ID: "draft_" + in.NewID(), OrgID: in.OrgID, WorkflowID: wf.ID, Document: document,
		Fixtures: json.RawMessage(`[]`), Digest: digest, CreatedBy: in.CreatedBy, Origin: origin,
	})
	return saved, err
}
