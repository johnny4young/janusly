package oauth

import (
	"errors"
	"net/http"
	"net/url"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/store"
)

func text(value string) pgtype.Text { return pgtype.Text{String: value, Valid: value != ""} }

func requestNotFound() httpkit.Result {
	return httpkit.Error(http.StatusNotFound, "oauth_request_not_found", "this connection request does not exist or has expired", nil)
}

func personOnly(rc httpkit.Request) *httpkit.Result {
	if rc.Auth == nil || !auth.IsPersonMode(rc.Auth.Mode) {
		result := httpkit.Error(http.StatusForbidden, "person_required", "only a signed-in person connects an agent", nil)
		return &result
	}
	return nil
}

// consentView is what the person reads before deciding. The client's name is
// whatever it registered: the screen shows it as unverified, next to the
// address the code will be sent to.
func (s *service) consentView(r *http.Request, rc httpkit.Request) httpkit.Result {
	if refused := personOnly(rc); refused != nil {
		return *refused
	}
	id := r.PathValue("requestId")
	if uuid.Validate(id) != nil {
		return requestNotFound()
	}
	q := store.New(s.pool)
	request, err := q.GetPendingOAuthRequest(r.Context(), store.GetPendingOAuthRequestParams{ID: id, Now: s.now().UTC()})
	if errors.Is(err, pgx.ErrNoRows) {
		return requestNotFound()
	}
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	held, err := agentclient.CreatorPermissions(r.Context(), q, rc.OrgID, rc.UserID)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	capabilities := make([]map[string]any, 0, len(request.Scopes))
	for _, name := range request.Scopes {
		missing := agentclient.MissingPermissions([]agentclient.Capability{agentclient.Capability(name)}, held)
		capabilities = append(capabilities, map[string]any{
			"capability": name, "grantable": held != nil && len(missing) == 0, "missingPermissions": missing,
		})
	}
	redirect, _ := url.Parse(request.RedirectUri)
	return httpkit.OK(map[string]any{
		"id": request.ID, "clientName": request.ClientName, "redirectHost": redirect.Host,
		"redirectIsLocal": loopbackHost(redirect.Hostname()), "organizationId": rc.OrgID,
		"capabilities": capabilities, "maxExpiresInDays": agentclient.MaxExpiryDays,
		"defaultExpiresInDays": agentclient.DefaultExpiryDays,
		"expiresAt":            request.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

type decisionBody struct {
	Approve      bool     `json:"approve"`
	Capabilities []string `json:"capabilities"`
	Scope        struct {
		WorkflowIDs []string `json:"workflowIds"`
		Tags        []string `json:"tags"`
	} `json:"scope"`
	ExpiresInDays int `json:"expiresInDays"`
}

// decide records the person's answer. Approving creates an agent client in
// the person's current organization, owned by them, and returns where to send
// the browser with a single-use code.
func (s *service) decide(r *http.Request, rc httpkit.Request) httpkit.Result {
	if refused := personOnly(rc); refused != nil {
		return *refused
	}
	var body decisionBody
	if err := httpkit.DecodeBodyBounded(r, &body, maxFormBytes); err != nil {
		return httpkit.Error(http.StatusBadRequest, "invalid_body", "request body is not a valid decision", nil)
	}
	id := r.PathValue("requestId")
	if uuid.Validate(id) != nil {
		return requestNotFound()
	}
	ctx := r.Context()
	now := s.now().UTC()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	request, err := q.GetPendingOAuthRequest(ctx, store.GetPendingOAuthRequestParams{ID: id, Now: now})
	if errors.Is(err, pgx.ErrNoRows) {
		return requestNotFound()
	}
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if !body.Approve {
		if _, err := q.DenyOAuthRequest(ctx, store.DenyOAuthRequestParams{ID: id, DecidedBy: text(rc.UserID), Now: now}); err != nil {
			return requestNotFound()
		}
		if err := tx.Commit(ctx); err != nil {
			return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
		return httpkit.OK(map[string]any{"redirectTo": redirectWith(request.RedirectUri, url.Values{
			"error": {"access_denied"}, "state": {request.State}, "iss": {s.issuer},
		})})
	}
	// Only what the client asked for can be granted, and never more.
	for _, capability := range body.Capabilities {
		if !slices.Contains(request.Scopes, capability) {
			return httpkit.Error(http.StatusBadRequest, "capability_not_requested",
				"a capability the client did not request cannot be granted", nil)
		}
	}
	held, err := agentclient.CreatorPermissions(ctx, q, rc.OrgID, rc.UserID)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if held == nil {
		return httpkit.Error(http.StatusForbidden, "membership_required", "an agent client acts for a member of this organization", nil)
	}
	issued, err := agentclient.Issue(ctx, q, uuid.NewString(), now, agentclient.IssueInput{
		OrgID: rc.OrgID, CreatedBy: rc.UserID, Name: request.ClientName, Capabilities: body.Capabilities,
		ScopeWorkflowIDs: body.Scope.WorkflowIDs, ScopeTags: body.Scope.Tags, ExpiresInDays: body.ExpiresInDays,
	}, held)
	var input *agentclient.InputError
	if errors.As(err, &input) {
		return httpkit.Error(http.StatusBadRequest, input.Code, input.Message, input.Params)
	}
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	// Issue's static token is discarded: this client only ever holds the
	// short-lived tokens the code exchange issues.
	if err := q.MarkAgentClientOAuth(ctx, store.MarkAgentClientOAuthParams{
		OrgID: rc.OrgID, ID: issued.Client.ID, OauthClientID: text(request.OauthClientID),
	}); err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	code, codeDigest, err := newSecret(codePrefix)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	// The registration is in use from here on, so the unused sweep keeps it.
	if err := q.TouchOAuthClient(ctx, request.OauthClientID); err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	codeExpires := now.Add(codeTTL)
	if _, err := q.ApproveOAuthRequest(ctx, store.ApproveOAuthRequestParams{
		ID: id, OrgID: text(rc.OrgID), DecidedBy: text(rc.UserID), AgentClientID: text(issued.Client.ID),
		CodeDigest: codeDigest, CodeExpiresAt: &codeExpires, Now: now,
	}); err != nil {
		return requestNotFound()
	}
	if err := tx.Commit(ctx); err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	redirect, _ := url.Parse(request.RedirectUri)
	s.audit.Write(ctx, s.pool, rc.Auth, "agent_client.created", audit.Options{
		TargetType: "agent_client", TargetID: issued.Client.ID,
		Metadata: map[string]any{
			"origin": "oauth", "oauthClientId": request.OauthClientID, "redirectHost": redirect.Host,
			"capabilities": issued.Client.Capabilities,
			"scope":        map[string]any{"workflowIds": issued.Client.ScopeWorkflowIds, "tags": issued.Client.ScopeTags},
			"expiresAt":    issued.Client.ExpiresAt.UTC().Format(time.RFC3339),
		},
	})
	return httpkit.OK(map[string]any{"redirectTo": redirectWith(request.RedirectUri, url.Values{
		"code": {code}, "state": {request.State}, "iss": {s.issuer},
	})})
}
