package agentsessions

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	defaultPage = 25
	maxPage     = 100
)

// Deps are the shared API dependencies of the read routes.
type Deps struct {
	Pool   *pgxpool.Pool
	Routes httpkit.Registrar
	Now    func() time.Time
}

type service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// Mount registers the observed-session read routes for people with runs.read.
func Mount(mux *http.ServeMux, deps Deps) {
	s := &service{pool: deps.Pool, now: deps.Now}
	if s.now == nil {
		s.now = time.Now
	}
	// Sessions name agent clients, so they also need agents.read (checked in
	// each handler; a gate holds one permission).
	read := httpkit.Gate{Role: auth.RoleViewer, Permission: "runs.read"}
	deps.Routes.Route(mux, "GET /agent-sessions", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.list(r, rc))
	})
	deps.Routes.Route(mux, "GET /v1/agent-sessions", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteVersioned(w, rc.ID, s.list(r, rc))
	})
	deps.Routes.Route(mux, "GET /agent-sessions/{sessionId}/map", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.sessionMap(r, rc))
	})
	deps.Routes.Route(mux, "GET /v1/agent-sessions/{sessionId}/map", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteVersioned(w, rc.ID, s.sessionMap(r, rc))
	})
}

func internalError() httpkit.Result {
	return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
}

// Holds reports whether the viewer's live grant includes permission, resolved
// the way the route gate resolves it.
func Holds(r *http.Request, pool *pgxpool.Pool, rc httpkit.Request, permission string) bool {
	if rc.Auth == nil {
		return false
	}
	q := store.New(pool)
	role, err := auth.ResolveRoleFromMembership(r.Context(), q, rc.OrgID, rc.Auth.MembershipRole, rc.Auth.Mode)
	if err != nil || role == nil {
		return false
	}
	permissions, err := auth.EffectivePermissions(r.Context(), q, rc.OrgID, role)
	return err == nil && permissions[permission]
}

func forbidden() httpkit.Result {
	return httpkit.Error(http.StatusForbidden, "server_request_failed", "Forbidden: requires permission agents.read", nil)
}

func (s *service) list(r *http.Request, rc httpkit.Request) httpkit.Result {
	if !Holds(r, s.pool, rc, "agents.read") {
		return forbidden()
	}
	limit := defaultPage
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxPage {
			return httpkit.Error(http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 100", nil)
		}
		limit = parsed
	}
	beforeAt, beforeID := time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC), "￿"
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		at, id, ok := decodeCursor(raw)
		if !ok {
			return httpkit.Error(http.StatusBadRequest, "invalid_cursor", "cursor is not valid", nil)
		}
		beforeAt, beforeID = at, id
	}
	rows, err := store.New(s.pool).ListAgentSessions(r.Context(), store.ListAgentSessionsParams{
		OrgID: rc.OrgID, BeforeAt: beforeAt, BeforeID: beforeID, PageLimit: int32(limit + 1),
	})
	if err != nil {
		return internalError()
	}
	var next any
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		next = encodeCursor(last.LastEventAt, last.ID)
	}
	now := s.now()
	sessions := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		sessions = append(sessions, sessionView(store.GetAgentSessionRow(row), now))
	}
	return httpkit.OK(map[string]any{"sessions": sessions, "nextCursor": next})
}

func (s *service) sessionMap(r *http.Request, rc httpkit.Request) httpkit.Result {
	if !Holds(r, s.pool, rc, "agents.read") {
		return forbidden()
	}
	q := store.New(s.pool)
	id := r.PathValue("sessionId")
	if uuid.Validate(id) != nil {
		return httpkit.Error(http.StatusNotFound, "agent_session_not_found", "agent session not found", nil)
	}
	row, err := q.GetAgentSession(r.Context(), store.GetAgentSessionParams{OrgID: rc.OrgID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpkit.Error(http.StatusNotFound, "agent_session_not_found", "agent session not found", nil)
	}
	if err != nil {
		return internalError()
	}
	rows, err := q.ListAgentSessionEvents(r.Context(), store.ListAgentSessionEventsParams{
		OrgID: rc.OrgID, SessionID: row.ID, RowLimit: agentsession.MaxStoredPerSession,
	})
	if err != nil {
		return internalError()
	}
	events := make([]agentsession.EventRow, 0, len(rows))
	for _, event := range rows {
		events = append(events, agentsession.EventRow{
			Seq: event.Seq.Int64, Type: event.Type, AgentID: event.AgentID.String, ParentAgentID: event.ParentAgentID.String,
			AgentType: event.AgentType.String, Tool: event.Tool.String, ToolKind: event.ToolKind.String,
			MCPServer: event.McpServer.String, Status: event.Status.String, DurationMs: optionalInt(event.DurationMs),
			Refs: event.JanuslyRefs, At: event.OccurredAt,
		})
	}
	graph := agentsession.Project(events)
	// Refs are what the agent reported; keep only runs its creator's agents started.
	verified, err := q.VerifyAgentSessionRunRefs(r.Context(), store.VerifyAgentSessionRunRefsParams{
		OrgID: rc.OrgID, AgentClientID: row.AgentClientID, RunIds: graph.Refs.RunIDs,
	})
	if err != nil {
		return internalError()
	}
	graph.Refs.RunIDs = append([]string{}, verified...)
	return httpkit.OK(map[string]any{
		"session": sessionView(row, s.now()), "lanes": graph.Lanes, "totals": graph.Totals,
		"liveSubagents": graph.LiveSubagents, "refs": graph.Refs,
	})
}

func sessionView(row store.GetAgentSessionRow, now time.Time) map[string]any {
	return map[string]any{
		"id": row.ID, "agentClientId": row.AgentClientID, "agentClientName": row.AgentClientName,
		"runtime": row.Runtime, "project": optionalText(row.Project), "model": optionalText(row.Model),
		"status":    agentsession.ReadStatus(row.Status, row.LastEventAt, now),
		"truncated": row.Truncated, "eventCount": row.EventCount,
		"startedAt": row.StartedAt.UTC().Format(time.RFC3339Nano), "lastEventAt": row.LastEventAt.UTC().Format(time.RFC3339Nano),
		"endedAt": optionalTime(row.EndedAt),
	}
}

func optionalText(value pgtype.Text) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func optionalTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func optionalInt(value pgtype.Int8) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func encodeCursor(at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id))
}

func decodeCursor(raw string) (time.Time, string, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return time.Time{}, "", false
	}
	at, id, found := strings.Cut(string(decoded), "|")
	parsed, err := time.Parse(time.RFC3339Nano, at)
	if !found || err != nil || uuid.Validate(id) != nil {
		return time.Time{}, "", false
	}
	return parsed, id, true
}
