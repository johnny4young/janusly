// Package agentclients serves the people-only routes that create, list,
// rotate and revoke external agent clients.
package agentclients

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"slices"
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
	routes := []struct {
		pattern string
		gate    httpkit.Gate
		issues  bool
		handle  func(*http.Request, httpkit.Request) httpkit.Result
	}{
		{"GET /agent-clients", read, false, s.list},
		{"GET /agent-clients/{id}", read, false, s.detail},
		{"POST /agent-clients", write, true, s.create},
		{"POST /agent-clients/{id}/rotate", write, true, s.rotate},
		{"POST /agent-clients/{id}/revoke", write, false, s.revoke},
	}
	for _, route := range routes {
		method, path, _ := strings.Cut(route.pattern, " ")
		handle, issues := route.handle, route.issues
		deps.Routes.Route(mux, route.pattern, route.gate, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
			if issues {
				w.Header().Set("Cache-Control", "no-store")
			}
			httpkit.WriteUnversioned(w, handle(r, rc))
		})
		deps.Routes.Route(mux, method+" /v1"+path, route.gate, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
			if issues {
				w.Header().Set("Cache-Control", "no-store")
			}
			httpkit.WriteVersioned(w, rc.ID, handle(r, rc))
		})
	}
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
	q := store.New(s.pool)
	rows, err := q.ListAgentClients(r.Context(), store.ListAgentClientsParams{
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
	users := []string{rc.UserID}
	for _, row := range rows {
		users = append(users, row.CreatedBy)
	}
	creators, err := loadCreatorGrants(r.Context(), q, rc.OrgID, users)
	if err != nil {
		return internalError()
	}
	held := creators.held[rc.UserID]
	now := s.now()
	clients := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		clients = append(clients, withAccess(view(row, now), creators.access(row)))
	}
	// What the caller could grant and the issuing limits, so a form never
	// copies policy the server owns.
	capabilities := make([]map[string]any, 0, len(agentclient.AllCapabilities))
	for _, capability := range agentclient.AllCapabilities {
		missing := agentclient.MissingPermissions([]agentclient.Capability{capability}, held)
		capabilities = append(capabilities, map[string]any{
			"name": string(capability), "grantable": held != nil && len(missing) == 0, "missingPermissions": missing,
		})
	}
	return httpkit.OK(map[string]any{
		"clients": clients, "nextCursor": next, "capabilities": capabilities,
		"limits": map[string]any{
			"defaultExpiryDays": agentclient.DefaultExpiryDays, "maxExpiryDays": agentclient.MaxExpiryDays,
			"defaultRateLimitPerMinute": agentclient.DefaultRatePerMinute, "maxRateLimitPerMinute": agentclient.MaxRatePerMinute,
		},
	})
}

// detail is what a person checks before trusting or ending a client: the
// tools each capability reaches, what the creator no longer holds, its latest
// calls and the publications it is waiting on.
func (s *service) detail(r *http.Request, rc httpkit.Request) httpkit.Result {
	q := store.New(s.pool)
	row, err := q.GetAgentClient(r.Context(), store.GetAgentClientParams{OrgID: rc.OrgID, ID: r.PathValue("id")})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpkit.Error(http.StatusNotFound, "agent_client_not_found", "agent client not found", nil)
	}
	if err != nil {
		return internalError()
	}
	creators, err := loadCreatorGrants(r.Context(), q, rc.OrgID, []string{row.CreatedBy})
	if err != nil {
		return internalError()
	}
	access, held := creators.access(row), creators.held[row.CreatedBy]
	parsed, _ := agentclient.ParseCapabilities(row.Capabilities)
	capabilities := make([]map[string]any, 0, len(parsed))
	for _, capability := range parsed {
		tools := slices.Sorted(maps.Keys(agentclient.CeilingTools([]agentclient.Capability{capability})))
		capabilities = append(capabilities, map[string]any{
			"name": string(capability), "tools": nonNil(tools),
			"missingPermissions": agentclient.MissingPermissions([]agentclient.Capability{capability}, held),
		})
	}
	caller, admin, err := callerGrant(r, q, rc)
	if err != nil {
		return internalError()
	}
	// Calls come from the audit log, which only admins read, and requests
	// name workflows: each shows only to someone who could read it elsewhere.
	// A denial's wording can describe server configuration, so only the
	// outcome travels.
	var recent, open any
	if row.CreatedBy == rc.UserID || (admin && caller["org.config.write"]) {
		calls, err := q.ListAgentClientToolCalls(r.Context(), store.ListAgentClientToolCallsParams{OrgID: rc.OrgID, Actor: "agent:" + row.ID})
		if err != nil {
			return internalError()
		}
		rows := make([]map[string]any, 0, len(calls))
		for _, call := range calls {
			var decision struct {
				Allowed bool `json:"allowed"`
			}
			_ = json.Unmarshal(call.Metadata, &decision)
			rows = append(rows, map[string]any{"tool": call.TargetID.String, "allowed": decision.Allowed, "at": optionalTime(call.CreatedAt)})
		}
		recent = rows
	}
	if caller["workflows.read"] {
		requests, err := q.ListAgentClientOpenRequests(r.Context(), store.ListAgentClientOpenRequestsParams{
			OrgID: rc.OrgID, Actor: "agent:" + row.ID,
		})
		if err != nil {
			return internalError()
		}
		rows := make([]map[string]any, 0, len(requests))
		for _, request := range requests {
			rows = append(rows, map[string]any{
				"id": request.ID, "workflowId": request.WorkflowID, "reasons": nonNil(request.Reasons),
				"createdAt": request.CreatedAt.UTC().Format(time.RFC3339), "expiresAt": request.ExpiresAt.UTC().Format(time.RFC3339),
			})
		}
		open = rows
	}
	return httpkit.OK(map[string]any{
		"client": withAccess(view(row, s.now()), access), "capabilities": capabilities,
		"recentCalls": recent, "openRequests": open,
	})
}

// callerGrant is the signed-in person's grant in the organization and whether
// their role ranks as admin; an automation caller holds nothing here.
func callerGrant(r *http.Request, q *store.Queries, rc httpkit.Request) (map[string]bool, bool, error) {
	if rc.Auth == nil || !auth.IsPersonMode(rc.Auth.Mode) {
		return map[string]bool{}, false, nil
	}
	role, err := auth.ResolveRoleFromMembership(r.Context(), q, rc.OrgID, rc.Auth.MembershipRole, rc.Auth.Mode)
	if err != nil || role == nil {
		return map[string]bool{}, false, err
	}
	permissions, err := auth.EffectivePermissions(r.Context(), q, rc.OrgID, role)
	if permissions == nil {
		permissions = map[string]bool{}
	}
	return permissions, role.InheritsFrom == auth.RoleAdmin, err
}

// creatorGrants holds each creator's current grant, nil for someone who is
// no longer a member, matching agentclient.CreatorPermissions. One query
// reads the memberships and each distinct role resolves once.
type creatorGrants struct {
	held map[string]map[string]bool
}

func loadCreatorGrants(ctx context.Context, q *store.Queries, orgID string, users []string) (creatorGrants, error) {
	grants := creatorGrants{held: map[string]map[string]bool{}}
	rows, err := q.ListMemberRoles(ctx, store.ListMemberRolesParams{OrgID: orgID, UserIds: users})
	if err != nil {
		return grants, err
	}
	literals := map[string]string{}
	for _, row := range rows {
		literals[row.UserID] = row.Role
	}
	byRole := map[string]map[string]bool{}
	for _, user := range users {
		literal := literals[user]
		permissions, cached := byRole[literal]
		if !cached && literal != "" {
			role, err := auth.ResolveRoleFromMembership(ctx, q, orgID, literal, auth.ModeSupabase)
			if err != nil {
				return grants, err
			}
			if permissions, err = auth.EffectivePermissions(ctx, q, orgID, role); err != nil {
				return grants, err
			}
			byRole[literal] = permissions
		}
		grants.held[user] = permissions
	}
	return grants, nil
}

// access says whether the creator still stands behind the client: removed
// when they left the organization, reduced when they lost a permission the
// client's capabilities rely on. Either way the server already narrows or
// refuses the token.
func (c creatorGrants) access(row store.AgentClient) map[string]any {
	held := c.held[row.CreatedBy]
	if held == nil {
		return map[string]any{"state": "removed", "missingPermissions": []string{}}
	}
	parsed, err := agentclient.ParseCapabilities(row.Capabilities)
	if err != nil {
		return map[string]any{"state": "reduced", "missingPermissions": []string{}}
	}
	if missing := agentclient.MissingPermissions(parsed, held); len(missing) > 0 {
		return map[string]any{"state": "reduced", "missingPermissions": missing}
	}
	return map[string]any{"state": "member", "missingPermissions": []string{}}
}

// rendered is a client view after a change. The change already succeeded, so
// an unreadable grant degrades to an unknown state instead of an error.
func (s *service) rendered(r *http.Request, row store.AgentClient, now time.Time) map[string]any {
	creators, err := loadCreatorGrants(r.Context(), store.New(s.pool), row.OrgID, []string{row.CreatedBy})
	if err != nil {
		return withAccess(view(row, now), map[string]any{"state": "unknown", "missingPermissions": []string{}})
	}
	return withAccess(view(row, now), creators.access(row))
}

func withAccess(client map[string]any, access map[string]any) map[string]any {
	client["creatorAccess"] = access
	return client
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
	ExpiresInDays      int `json:"expiresInDays"`
	RateLimitPerMinute int `json:"rateLimitPerMinute"`
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
		},
	})
	return httpkit.Result{Status: http.StatusCreated, Data: map[string]any{
		"client": s.rendered(r, issued.Client, now), "token": issued.Token,
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
	return httpkit.OK(map[string]any{"client": s.rendered(r, issued.Client, now), "token": issued.Token})
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
	return httpkit.OK(map[string]any{"client": s.rendered(r, row, s.now())})
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
		"tokenLast4":         row.TokenLast4,
		"createdBy":          row.CreatedBy,
		"createdAt":          row.CreatedAt.UTC().Format(time.RFC3339),
		"tokenIssuedAt":      row.TokenIssuedAt.UTC().Format(time.RFC3339),
		"expiresAt":          row.ExpiresAt.UTC().Format(time.RFC3339),
		"revokedAt":          optionalTime(row.RevokedAt),
		"lastUsedAt":         optionalTime(row.LastUsedAt),
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
