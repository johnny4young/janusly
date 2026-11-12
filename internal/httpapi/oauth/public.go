package oauth

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func asLimit(err error, target **ratelimit.LimitError) bool { return errors.As(err, target) }

func itoa(value int) string { return strconv.Itoa(value) }

type registration struct {
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
}

// clientName keeps a registered name printable; it is shown as unverified.
func clientName(raw string) string {
	// Plain ASCII only: a name cannot carry look-alike letters or marks that
	// read as an endorsement.
	name := strings.TrimSpace(strings.Map(func(r rune) rune {
		if r > unicode.MaxASCII || !unicode.IsPrint(r) {
			return -1
		}
		return r
	}, signature.ScrubSecretShapes(raw)))
	if name == "" {
		return "MCP client"
	}
	if utf8.RuneCountInString(name) > 100 {
		name = string([]rune(name)[:100])
	}
	return name
}

// register is RFC 7591 for public clients only. Unknown metadata is ignored,
// as the RFC allows; nothing here grants access.
func (s *service) register(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, r, registerLimit) {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFormBytes))
	var body registration
	if err != nil || json.Unmarshal(raw, &body) != nil {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "the registration is not valid JSON under 8 KB")
		return
	}
	if len(body.RedirectURIs) == 0 || len(body.RedirectURIs) > 5 {
		oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "register between 1 and 5 redirect_uris")
		return
	}
	for _, redirect := range body.RedirectURIs {
		if !validRedirect(redirect) {
			oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "a redirect_uri must be https, or http on a loopback address, without fragment or credentials")
			return
		}
	}
	if method := body.TokenEndpointAuthMethod; method != "" && method != "none" {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "only public clients are supported: token_endpoint_auth_method must be none")
		return
	}
	for _, grant := range body.GrantTypes {
		if grant != "authorization_code" && grant != "refresh_token" {
			oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "grant_types may be authorization_code and refresh_token")
			return
		}
	}
	q := store.New(s.pool)
	unused, err := q.CountUnusedOAuthClients(r.Context())
	if err != nil {
		oauthError(w, http.StatusInternalServerError, "server_error", "registration failed")
		return
	}
	// At the cap the oldest registration nobody used makes room, so filling
	// the table cannot lock new clients out.
	if unused >= maxUnusedClients {
		now := s.now().UTC()
		evicted, err := q.EvictOldestUnusedOAuthClient(r.Context(), store.EvictOldestUnusedOAuthClientParams{
			SettledBefore: now.Add(-evictionMinAge), Now: now,
		})
		if err != nil || evicted == 0 {
			oauthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "too many new registrations; retry in a few minutes")
			return
		}
	}
	client, err := q.InsertOAuthClient(r.Context(), store.InsertOAuthClientParams{
		ID: "oc_" + uuid.NewString(), ClientName: clientName(body.ClientName),
		RedirectUris: body.RedirectURIs, RegisteredFrom: httpkit.ClientAddress(r),
	})
	if err != nil {
		oauthError(w, http.StatusInternalServerError, "server_error", "registration failed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id": client.ID, "client_id_issued_at": client.CreatedAt.Unix(),
		"client_name": client.ClientName, "redirect_uris": client.RedirectUris,
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"},
		"token_endpoint_auth_method": "none",
	})
}

// authorize validates the request and hands it to the consent screen. A bad
// client or redirect answers here and never redirects; every other error goes
// back to the registered redirect with the state.
func (s *service) authorize(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
	if s.limited(w, r, authorizeLimit) {
		return
	}
	query := r.URL.Query()
	q := store.New(s.pool)
	client, err := q.GetOAuthClient(r.Context(), query.Get("client_id"))
	redirect := query.Get("redirect_uri")
	if err != nil || !redirectMatches(client.RedirectUris, redirect) {
		http.Error(w, "This authorization link is not valid: unknown client or redirect address.", http.StatusBadRequest)
		return
	}
	state := query.Get("state")
	if len(state) > 512 {
		state = ""
	}
	fail := func(code, description string) {
		http.Redirect(w, r, redirectWith(redirect, url.Values{
			"error": {code}, "error_description": {description}, "state": {state}, "iss": {s.issuer},
		}), http.StatusFound)
	}
	scopes, scopesOK := parseScopes(query.Get("scope"))
	switch {
	case state == "":
		fail("invalid_request", "state is required, at most 512 characters")
	case query.Get("response_type") != "code":
		fail("unsupported_response_type", "response_type must be code")
	case query.Get("code_challenge_method") != "S256" || !challengePattern.MatchString(query.Get("code_challenge")):
		fail("invalid_request", "PKCE with code_challenge_method S256 is required")
	case query.Get("resource") != "" && query.Get("resource") != Resource(s.issuer):
		fail("invalid_target", "resource must be this server's MCP endpoint")
	case !scopesOK:
		fail("invalid_scope", "unknown scope")
	default:
		// Bounded per client, so one caller's requests never crowd out another's.
		if pending, err := q.CountPendingOAuthRequests(r.Context(), store.CountPendingOAuthRequestsParams{
			OauthClientID: client.ID, Now: s.now().UTC(),
		}); err != nil || pending >= maxPendingPerClient {
			fail("temporarily_unavailable", "too many pending requests for this client; retry later")
			return
		}
		// A total ceiling too: past it the oldest unanswered request makes room.
		if total, err := q.CountAllPendingOAuthRequests(r.Context()); err == nil && total >= maxPendingRequests {
			_ = q.EvictOldestPendingOAuthRequest(r.Context())
		}
		request, err := q.InsertOAuthRequest(r.Context(), store.InsertOAuthRequestParams{
			ID: uuid.NewString(), OauthClientID: client.ID, RedirectUri: redirect,
			CodeChallenge: query.Get("code_challenge"), Scopes: scopes, State: state,
			Resource: Resource(s.issuer), ExpiresAt: s.now().UTC().Add(requestTTL),
		})
		if err != nil {
			fail("server_error", "the request could not be stored")
			return
		}
		// The consent lives in the signed-in web app, under Settings → Access.
		http.Redirect(w, r, s.issuer+"/?oauth_request="+url.QueryEscape(request.ID)+"#/operations/access", http.StatusFound)
	}
}

func redirectWith(redirect string, values url.Values) string {
	parsed, err := url.Parse(redirect)
	if err != nil {
		return redirect
	}
	query := parsed.Query()
	for key, list := range values {
		if len(list) > 0 && list[0] != "" {
			query.Set(key, list[0])
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

type tokenReply struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

var errInvalidGrant = errors.New("invalid grant")

// token exchanges a code or rotates a refresh token. Every refusal reads the
// same, so it tells a caller nothing about why.
func (s *service) token(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, r, tokenLimit) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_request", "the token request is not a valid form")
		return
	}
	form := r.PostForm
	var reply tokenReply
	var err error
	switch form.Get("grant_type") {
	case "authorization_code":
		reply, err = s.exchangeCode(r, form)
	case "refresh_token":
		reply, err = s.refresh(r, form)
	default:
		oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
		return
	}
	switch {
	case errors.Is(err, errInvalidGrant):
		oauthError(w, http.StatusBadRequest, "invalid_grant", "the code or refresh token is invalid, expired or already used")
	case err != nil:
		s.logger.Error("oauth token failed", "error", err)
		oauthError(w, http.StatusInternalServerError, "server_error", "the token could not be issued")
	default:
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		writeJSON(w, http.StatusOK, reply)
	}
}

func (s *service) exchangeCode(r *http.Request, form url.Values) (tokenReply, error) {
	ctx := r.Context()
	now := s.now().UTC()
	code := form.Get("code")
	if !strings.HasPrefix(code, codePrefix) {
		return tokenReply{}, errInvalidGrant
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return tokenReply{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	request, err := q.LockOAuthRequestByCode(ctx, digest(code))
	if errors.Is(err, pgx.ErrNoRows) {
		return tokenReply{}, errInvalidGrant
	}
	if err != nil {
		return tokenReply{}, err
	}
	// A code presented again means it leaked and the grant it made ends. The
	// one exception is a retry that proves it is the same client: within the
	// grace window, with the same client, redirect and PKCE verifier.
	if request.CodeUsedAt != nil {
		sameCaller := form.Get("client_id") == request.OauthClientID && form.Get("redirect_uri") == request.RedirectUri &&
			pkceMatches(form.Get("code_verifier"), request.CodeChallenge)
		if sameCaller && now.Sub(*request.CodeUsedAt) <= retryGrace {
			return tokenReply{}, errInvalidGrant
		}
		if err := s.endGrant(r, q, request.OrgID.String, request.AgentClientID.String, codeReuseAction); err != nil {
			return tokenReply{}, err
		}
		return tokenReply{}, errors.Join(errInvalidGrant, tx.Commit(ctx))
	}
	resource := form.Get("resource")
	if request.CodeExpiresAt == nil || !now.Before(*request.CodeExpiresAt) ||
		form.Get("client_id") != request.OauthClientID || form.Get("redirect_uri") != request.RedirectUri ||
		(resource != "" && resource != request.Resource) || !pkceMatches(form.Get("code_verifier"), request.CodeChallenge) {
		return tokenReply{}, errInvalidGrant
	}
	if err := q.MarkOAuthCodeUsed(ctx, store.MarkOAuthCodeUsedParams{ID: request.ID, Now: &now}); err != nil {
		return tokenReply{}, err
	}
	reply, err := s.issue(r, q, request.AgentClientID.String, request.OauthClientID, now)
	if err != nil {
		return tokenReply{}, err
	}
	if err := q.TouchOAuthClient(ctx, request.OauthClientID); err != nil {
		return tokenReply{}, err
	}
	return reply, tx.Commit(ctx)
}

func (s *service) refresh(r *http.Request, form url.Values) (tokenReply, error) {
	ctx := r.Context()
	presented := form.Get("refresh_token")
	if !strings.HasPrefix(presented, refreshPrefix) {
		return tokenReply{}, errInvalidGrant
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return tokenReply{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	now := s.now().UTC()
	presentedDigest := digest(presented)
	client, err := q.LockAgentClientByRefresh(ctx, presentedDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		// A refresh token rotated away, however long ago, means it leaked and
		// the grant ends, unless it is the same client retrying right after.
		rotated, historyErr := q.GetOAuthRefreshHistory(ctx, presentedDigest)
		if historyErr != nil {
			return tokenReply{}, errInvalidGrant
		}
		// A retry right after the rotation, naming the client the token was issued to.
		if form.Get("client_id") == rotated.OauthClientID && now.Sub(rotated.RotatedAt) <= retryGrace {
			return tokenReply{}, errInvalidGrant
		}
		if err := s.endGrant(r, q, rotated.OrgID, rotated.AgentClientID, refreshReuseAction); err != nil {
			return tokenReply{}, err
		}
		return tokenReply{}, errors.Join(errInvalidGrant, tx.Commit(ctx))
	}
	if err != nil {
		return tokenReply{}, err
	}
	if client.OauthClientID.String != form.Get("client_id") || form.Get("client_id") == "" {
		return tokenReply{}, errInvalidGrant
	}
	if err := q.InsertOAuthRefreshHistory(ctx, store.InsertOAuthRefreshHistoryParams{
		Digest: presentedDigest, AgentClientID: client.ID, RotatedAt: now,
	}); err != nil {
		return tokenReply{}, err
	}
	reply, err := s.issue(r, q, client.ID, client.OauthClientID.String, now)
	if err != nil {
		return tokenReply{}, err
	}
	return reply, tx.Commit(ctx)
}

// issue rotates the client's access and refresh tokens. A revoked or expired
// client matches no row, so refreshing never revives or extends a grant.
func (s *service) issue(r *http.Request, q *store.Queries, agentClientID, oauthClientID string, now time.Time) (tokenReply, error) {
	access, accessDigest, last4, err := agentclient.NewToken()
	if err != nil {
		return tokenReply{}, err
	}
	refresh, refreshDigest, err := newSecret(refreshPrefix)
	if err != nil {
		return tokenReply{}, err
	}
	expires := now.Add(AccessTTL)
	client, err := q.IssueOAuthTokens(r.Context(), store.IssueOAuthTokensParams{
		ID: agentClientID, OauthClientID: text(oauthClientID), TokenDigest: accessDigest, TokenLast4: last4,
		AccessExpiresAt: &expires, RefreshDigest: refreshDigest, Now: now,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return tokenReply{}, errInvalidGrant
	}
	if err != nil {
		return tokenReply{}, err
	}
	// The access token never outlives the client it belongs to.
	seconds := int(min(AccessTTL, client.ExpiresAt.Sub(now)).Seconds())
	return tokenReply{AccessToken: access, TokenType: "Bearer", ExpiresIn: seconds, RefreshToken: refresh, Scope: scopeString(client.Capabilities)}, nil
}

func (s *service) endGrant(r *http.Request, q *store.Queries, orgID, agentClientID string, action audit.Action) error {
	revoked, err := q.RevokeOAuthAgentClient(r.Context(), store.RevokeOAuthAgentClientParams{ID: agentClientID, RevokedBy: "oauth:replay"})
	if err != nil || revoked == 0 {
		return err
	}
	s.audit.SystemWrite(r.Context(), s.pool, orgID, "anonymous", action, audit.Options{
		TargetType: "agent_client", TargetID: agentClientID,
		Metadata: map[string]any{"clientAddress": httpkit.ClientAddress(r)},
	})
	return nil
}
