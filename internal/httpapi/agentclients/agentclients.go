// Package agentclients serves the people-only routes that create, list,
// rotate and revoke external agent clients.
package agentclients

import (
	"encoding/base64"
	"errors"
	"maps"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/store"
)

func init() {
	for _, action := range []audit.Action{"agent_client.created", "agent_client.rotated", "agent_client.revoked"} {
		audit.RegisterRuntimeAction(action)
	}
}

const maxBodyBytes = 16 << 10

// Deps are the shared API dependencies.
type Deps struct {
	Audit  audit.Writer
	Pool   *pgxpool.Pool
	Routes httpkit.Registrar
	Now    func() time.Time
}

type service struct {
	audit audit.Writer
	pool  *pgxpool.Pool
	now   func() time.Time
}

// Mount registers the agent client routes.
func Mount(mux *http.ServeMux, deps Deps) {
	s := &service{audit: deps.Audit, pool: deps.Pool, now: deps.Now}
	if s.now == nil {
		s.now = time.Now
	}
	read := httpkit.Gate{Role: auth.RoleViewer, Permission: "agents.read"}
	write := httpkit.Gate{Role: auth.RoleEditor, Permission: "agents.write"}
	deps.Routes.Route(mux, "GET /agent-clients", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.list(r, rc))
	})
	deps.Routes.Route(mux, "POST /agent-clients", write, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpkit.WriteUnversioned(w, s.create(r, rc))
	})
	deps.Routes.Route(mux, "POST /agent-clients/{id}/rotate", write, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpkit.WriteUnversioned(w, s.rotate(r, rc))
	})
	deps.Routes.Route(mux, "POST /agent-clients/{id}/revoke", write, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.revoke(r, rc))
	})
}

// requirePerson refuses automation: a service token has no person to act
// for, so it can neither own nor manage an agent client.
func requirePerson(rc httpkit.Request) *httpkit.Result {
	if rc.Auth == nil || !auth.IsPersonMode(rc.Auth.Mode) {
		result := httpkit.Error(http.StatusForbidden, "person_required", "agent clients are managed by a signed-in person", nil)
		return &result
	}
	return nil
}

// maxListPage is also the default page, so a caller that ignores the cursor
// sees what it saw before pagination.
const maxListPage = 200

func (s *service) list(r *http.Request, rc httpkit.Request) httpkit.Result {
	limit := maxListPage
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxListPage {
			return httpkit.Error(http.StatusBadRequest, "invalid_limit", "limit must be between 1 and 200", nil)
		}
		limit = parsed
	}
	beforeAt, beforeID := time.Date(9999, time.January, 1, 0, 0, 0, 0, time.UTC), ""
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		at, id, ok := decodeCursor(raw)
		if !ok {
			return httpkit.Error(http.StatusBadRequest, "invalid_cursor", "cursor is not one this list returned", nil)
		}
		beforeAt, beforeID = at, id
	}
	rows, err := store.New(s.pool).ListAgentClients(r.Context(), store.ListAgentClientsParams{
		OrgID: rc.OrgID, BeforeCreatedAt: beforeAt, BeforeID: beforeID, PageLimit: int32(limit + 1),
	})
	if err != nil {
		return internalError()
	}
	var next any
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	now := s.now()
	clients := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		clients = append(clients, view(row, now))
	}
	return httpkit.OK(map[string]any{"clients": clients, "nextCursor": next})
}

func encodeCursor(createdAt time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(createdAt.UTC().Format(time.RFC3339Nano) + "|" + id))
}

func decodeCursor(raw string) (time.Time, string, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return time.Time{}, "", false
	}
	at, id, found := strings.Cut(string(decoded), "|")
	parsed, err := time.Parse(time.RFC3339Nano, at)
	if !found || err != nil || id == "" {
		return time.Time{}, "", false
	}
	return parsed, id, true
}

type createBody struct {
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
	Scope        struct {
		WorkflowIDs []string `json:"workflowIds"`
		Tags        []string `json:"tags"`
	} `json:"scope"`
	ExpiresInDays      int      `json:"expiresInDays"`
	RateLimitPerMinute int      `json:"rateLimitPerMinute"`
	GateTools          []string `json:"gateTools"`
	CaptureContent     bool     `json:"captureContent"`
}

func (s *service) create(r *http.Request, rc httpkit.Request) httpkit.Result {
	if refused := requirePerson(rc); refused != nil {
		return *refused
	}
	var body createBody
	if err := httpkit.DecodeBodyBounded(r, &body, maxBodyBytes); err != nil {
		return httpkit.Error(http.StatusBadRequest, "invalid_body", "request body is not a valid agent client", nil)
	}
	q := store.New(s.pool)
	held, err := agentclient.CreatorPermissions(r.Context(), q, rc.OrgID, rc.UserID)
	if err != nil {
		return internalError()
	}
	if held == nil {
		return httpkit.Error(http.StatusForbidden, "membership_required",
			"an agent client acts for a member of this organization", nil)
	}
	now := s.now()
	issued, err := agentclient.Issue(r.Context(), q, uuid.NewString(), now, agentclient.IssueInput{
		OrgID: rc.OrgID, CreatedBy: rc.UserID, Name: body.Name, Capabilities: body.Capabilities,
		ScopeWorkflowIDs: body.Scope.WorkflowIDs, ScopeTags: body.Scope.Tags,
		ExpiresInDays: body.ExpiresInDays, RateLimitPerMinute: body.RateLimitPerMinute,
		GateTools: body.GateTools, CaptureContent: body.CaptureContent,
	}, held)
	if result, failed := inputFailure(err); failed {
		return result
	}
	s.audit.Write(r.Context(), s.pool, rc.Auth, "agent_client.created", audit.Options{
		TargetType: "agent_client", TargetID: issued.Client.ID,
		Metadata: map[string]any{
			"capabilities": issued.Client.Capabilities,
			"scope":        map[string]any{"workflowIds": issued.Client.ScopeWorkflowIds, "tags": issued.Client.ScopeTags},
			"expiresAt":    issued.Client.ExpiresAt.UTC().Format(time.RFC3339),
			"gateTools":    issued.Client.GateTools, "captureContent": issued.Client.CaptureContent,
		},
	})
	return httpkit.Result{Status: http.StatusCreated, Data: map[string]any{
		"client": view(issued.Client, now), "token": issued.Token,
	}}
}

type rotateBody struct {
	ExpiresInDays int `json:"expiresInDays"`
}

func (s *service) rotate(r *http.Request, rc httpkit.Request) httpkit.Result {
	existing, refused := s.managed(r, rc, false)
	if refused != nil {
		return *refused
	}
	var body rotateBody
	if r.ContentLength != 0 {
		if err := httpkit.DecodeBodyBounded(r, &body, maxBodyBytes); err != nil {
			return httpkit.Error(http.StatusBadRequest, "invalid_body", "request body is not a valid rotation", nil)
		}
	}
	now := s.now()
	// Expiry ends a client like revocation does; rotation never revives it.
	if existing.RevokedAt == nil && !now.Before(existing.ExpiresAt) {
		return httpkit.Error(http.StatusConflict, "agent_client_expired", "agent client has expired; create a new one", nil)
	}
	issued, err := agentclient.Rotate(r.Context(), store.New(s.pool), rc.OrgID, existing.ID, now, body.ExpiresInDays)
	if errors.Is(err, pgx.ErrNoRows) {
		return revokedConflict()
	}
	if result, failed := inputFailure(err); failed {
		return result
	}
	s.audit.Write(r.Context(), s.pool, rc.Auth, "agent_client.rotated", audit.Options{
		TargetType: "agent_client", TargetID: existing.ID,
		Metadata: map[string]any{"expiresAt": issued.Client.ExpiresAt.UTC().Format(time.RFC3339)},
	})
	return httpkit.OK(map[string]any{"client": view(issued.Client, now), "token": issued.Token})
}

func (s *service) revoke(r *http.Request, rc httpkit.Request) httpkit.Result {
	existing, refused := s.managed(r, rc, true)
	if refused != nil {
		return *refused
	}
	row, err := store.New(s.pool).RevokeAgentClient(r.Context(), store.RevokeAgentClientParams{
		OrgID: rc.OrgID, ID: existing.ID, RevokedBy: rc.UserID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return revokedConflict()
	}
	if err != nil {
		return internalError()
	}
	s.audit.Write(r.Context(), s.pool, rc.Auth, "agent_client.revoked", audit.Options{
		TargetType: "agent_client", TargetID: existing.ID,
	})
	return httpkit.OK(map[string]any{"client": view(row, s.now())})
}

// managed loads a client the caller may change: their own, or, for revoke,
// any client when they hold an admin-ranked role. Rotation stays with the
// creator, because the new token acts with the creator's authority.
func (s *service) managed(r *http.Request, rc httpkit.Request, adminMay bool) (store.AgentClient, *httpkit.Result) {
	if refused := requirePerson(rc); refused != nil {
		return store.AgentClient{}, refused
	}
	q := store.New(s.pool)
	row, err := q.GetAgentClient(r.Context(), store.GetAgentClientParams{OrgID: rc.OrgID, ID: r.PathValue("id")})
	if errors.Is(err, pgx.ErrNoRows) {
		result := httpkit.Error(http.StatusNotFound, "agent_client_not_found", "agent client not found", nil)
		return store.AgentClient{}, &result
	}
	if err != nil {
		result := internalError()
		return store.AgentClient{}, &result
	}
	if row.CreatedBy == rc.UserID {
		return row, nil
	}
	if !adminMay {
		result := httpkit.Error(http.StatusForbidden, "agent_client_not_owned",
			"only the creator can rotate this agent client; an admin can revoke it", nil)
		return store.AgentClient{}, &result
	}
	role, err := auth.ResolveRoleFromMembership(r.Context(), q, rc.OrgID, rc.Auth.MembershipRole, rc.Auth.Mode)
	if err != nil {
		result := internalError()
		return store.AgentClient{}, &result
	}
	if role == nil || role.InheritsFrom != auth.RoleAdmin {
		result := httpkit.Error(http.StatusForbidden, "agent_client_not_owned",
			"only the creator or an admin can change this agent client", nil)
		return store.AgentClient{}, &result
	}
	return row, nil
}

func inputFailure(err error) (httpkit.Result, bool) {
	if err == nil {
		return httpkit.Result{}, false
	}
	var input *agentclient.InputError
	if errors.As(err, &input) {
		params := map[string]any{"field": input.Field}
		maps.Copy(params, input.Params)
		return httpkit.Error(http.StatusBadRequest, input.Code, input.Message, params), true
	}
	return internalError(), true
}

func revokedConflict() httpkit.Result {
	return httpkit.Error(http.StatusConflict, "agent_client_revoked", "agent client is already revoked", nil)
}

func internalError() httpkit.Result {
	return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
}

func view(row store.AgentClient, now time.Time) map[string]any {
	status := "active"
	switch {
	case row.RevokedAt != nil:
		status = "revoked"
	case !now.Before(row.ExpiresAt):
		status = "expired"
	}
	return map[string]any{
		"id": row.ID, "name": row.Name, "status": status,
		"capabilities":       row.Capabilities,
		"scope":              map[string]any{"workflowIds": nonNil(row.ScopeWorkflowIds), "tags": nonNil(row.ScopeTags)},
		"rateLimitPerMinute": row.RateLimitPerMinute,
		"gateTools":          nonNil(row.GateTools), "captureContent": row.CaptureContent,
		"tokenLast4":    row.TokenLast4,
		"createdBy":     row.CreatedBy,
		"createdAt":     row.CreatedAt.UTC().Format(time.RFC3339),
		"tokenIssuedAt": row.TokenIssuedAt.UTC().Format(time.RFC3339),
		"expiresAt":     row.ExpiresAt.UTC().Format(time.RFC3339),
		"revokedAt":     optionalTime(row.RevokedAt),
		"lastUsedAt":    optionalTime(row.LastUsedAt),
	}
}

func optionalTime(at *time.Time) any {
	if at == nil {
		return nil
	}
	return at.UTC().Format(time.RFC3339)
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
