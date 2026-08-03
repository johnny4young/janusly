//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/authpolicy"
	"github.com/johnny4young/janusly/go/internal/browsersession"
	"github.com/johnny4young/janusly/go/internal/ssostate"
	"github.com/johnny4young/janusly/go/internal/store"
	"github.com/johnny4young/janusly/go/internal/workos"
)

type stubWorkOSClient struct {
	profile       workos.Profile
	exchangeError error
	exchangeCalls int
}

func (c *stubWorkOSClient) BuildAuthorizeURL(_, _, _ string) (string, error) {
	return "https://api.workos.com/sso/authorize?stub=1", nil
}

func (c *stubWorkOSClient) ExchangeCode(context.Context, string, string) (workos.Profile, error) {
	c.exchangeCalls++
	return c.profile, c.exchangeError
}

func newPublicSsoServer(t *testing.T, pool *pgxpool.Pool, client workosClient, newID func() string) *httptest.Server {
	t.Helper()
	if newID == nil {
		newID = uuid.NewString
	}
	server := &V1Server{pool: pool, newID: newID, workos: client, authPolicy: authpolicy.New(pool)}
	mux := http.NewServeMux()
	server.mountSsoRoutes(mux)
	probe := httptest.NewServer(WithBrowserHeaders(mux))
	t.Cleanup(probe.Close)
	return probe
}

func callPublicSso(t *testing.T, baseURL, path string, bindingNonce ...string) (int, http.Header, map[string]any) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, baseURL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	// A real browser returns from the identity provider carrying the
	// binding cookie startSso set; omitting it models a callback replayed
	// in a DIFFERENT browser.
	if len(bindingNonce) == 1 && bindingNonce[0] != "" {
		request.AddCookie(&http.Cookie{Name: ssostate.BrowserCookieName, Value: bindingNonce[0]})
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body := map[string]any{}
	_ = json.NewDecoder(response.Body).Decode(&body)
	return response.StatusCode, response.Header, body
}

func seedSsoConnection(t *testing.T, pool *pgxpool.Pool, orgID, connectionID string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := store.New(pool).CreateSsoConnection(t.Context(), store.CreateSsoConnectionParams{
		ID: id, OrgID: orgID, Provider: "workos", ProviderConnectionID: connectionID,
	}); err != nil {
		t.Fatalf("seed SSO connection: %v", err)
	}
	return id
}

// issueCallbackState returns the signed state AND its nonce: the nonce is
// what the initiating browser carries back as the binding cookie, so a
// test that wants a legitimate callback must present both.
func issueCallbackState(t *testing.T, pool *pgxpool.Pool, orgID, callbackURL string, persistNonce bool) (string, string) {
	t.Helper()
	nonce := uuid.NewString()
	state, err := ssostate.Create(orgID, nonce, callbackURL)
	if err != nil {
		t.Fatal(err)
	}
	if persistNonce {
		if err := store.New(pool).RecordSsoNonce(t.Context(), store.RecordSsoNonceParams{
			ID: uuid.NewString(), OrgID: orgID, Nonce: nonce, ExpiresAt: state.ExpiresAt,
		}); err != nil {
			t.Fatal(err)
		}
	}
	return state.Value, nonce
}

func callSsoWithoutFollowing(t *testing.T, h *apiHarness, path string) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, h.server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response.StatusCode, response.Header, body
}

func callSsoList(t *testing.T, h *apiHarness, orgID string) (int, []map[string]any) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, h.server.URL+"/org/sso/connections", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("x-org-id", orgID)
	request.Header.Set("x-user-id", "api-tester")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var rows []map[string]any
	_ = json.NewDecoder(response.Body).Decode(&rows)
	return response.StatusCode, rows
}

func TestSsoAdminCrudIsTenantScopedAndAudited(t *testing.T) {
	t.Setenv("ALLOW_DEV_SSO_BYPASS", "true")
	h := newAPIHarness(t)
	pool := testPool(t)

	invalid := h.call(http.MethodPost, "/org/sso/connections", map[string]any{
		"provider": "other", "providerConnectionId": "conn_bad",
	}, "")
	if invalid.status != http.StatusBadRequest || invalid.body["code"] != "sso_provider_invalid" {
		t.Fatalf("provider validation: %d %+v", invalid.status, invalid.body)
	}
	created := h.call(http.MethodPost, "/org/sso/connections", map[string]any{
		"provider": "workos", "providerConnectionId": "  conn_acme  ", "enforcedSso": true,
	}, "")
	connectionID, _ := created.body["id"].(string)
	if created.status != http.StatusOK || connectionID == "" ||
		created.body["providerConnectionId"] != "conn_acme" || created.body["enforcedSso"] != true {
		t.Fatalf("create: %d %+v", created.status, created.body)
	}
	duplicate := h.call(http.MethodPost, "/org/sso/connections", map[string]any{
		"provider": "workos", "providerConnectionId": "conn_duplicate",
	}, "")
	if duplicate.status != http.StatusConflict || duplicate.body["code"] != "sso_connection_exists" {
		t.Fatalf("duplicate: %d %+v", duplicate.status, duplicate.body)
	}

	status, rows := callSsoList(t, h, h.org)
	if status != http.StatusOK || len(rows) != 1 || rows[0]["id"] != connectionID {
		t.Fatalf("list: %d %+v", status, rows)
	}
	foreignOrg := h.org + "-foreign"
	if status, rows := callSsoList(t, h, foreignOrg); status != http.StatusOK || len(rows) != 0 {
		t.Fatalf("foreign list: %d %+v", status, rows)
	}
	crossOrg := h.call(http.MethodPost, "/org/sso/connections/"+connectionID,
		map[string]any{"enforcedSso": false}, foreignOrg)
	if crossOrg.status != http.StatusNotFound || crossOrg.body["code"] != "sso_connection_not_found" {
		t.Fatalf("cross-org update: %d %+v", crossOrg.status, crossOrg.body)
	}
	noFields := h.call(http.MethodPost, "/org/sso/connections/"+connectionID,
		map[string]any{"status": "unknown"}, "")
	if noFields.status != http.StatusBadRequest || noFields.body["code"] != "sso_no_updatable_fields" {
		t.Fatalf("empty update: %d %+v", noFields.status, noFields.body)
	}
	updated := h.call(http.MethodPost, "/org/sso/connections/"+connectionID, map[string]any{
		"status": "active", "enforcedSso": false, "providerConnectionId": " conn_rotated ",
	}, "")
	if updated.status != http.StatusOK || updated.body["providerConnectionId"] != "conn_rotated" ||
		updated.body["enforcedSso"] != false {
		t.Fatalf("update: %d %+v", updated.status, updated.body)
	}
	revoked := h.call(http.MethodDelete, "/org/sso/connections/"+connectionID, nil, "")
	if revoked.status != http.StatusOK || revoked.body["ok"] != true {
		t.Fatalf("revoke: %d %+v", revoked.status, revoked.body)
	}
	if status, rows := callSsoList(t, h, h.org); status != http.StatusOK || len(rows) != 1 || rows[0]["status"] != "revoked" {
		t.Fatalf("revoked list: %d %+v", status, rows)
	}

	var actions int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action IN ('org.sso.connection_added','org.sso.connection_updated','org.sso.connection_revoked')`, h.org).Scan(&actions); err != nil || actions != 3 {
		t.Fatalf("admin audits: count=%d err=%v", actions, err)
	}
}

func TestSsoStartCreatesBoundSingleUseStateAndRedirectsWithoutAuth(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "sso-start-test-secret")
	t.Setenv("WORKOS_CLIENT_ID", "client_start_test")
	t.Setenv("JANUSLY_SSO_CALLBACK_URL", "https://api.example.com/auth/sso/callback")
	h := newAPIHarness(t)
	pool := testPool(t)
	created := h.call(http.MethodPost, "/org/sso/connections", map[string]any{
		"provider": "workos", "providerConnectionId": "conn_start",
	}, "")
	connectionID, _ := created.body["id"].(string)
	if connectionID == "" {
		t.Fatalf("seed connection: %d %+v", created.status, created.body)
	}

	status, headers, body := callSsoWithoutFollowing(t, h, "/auth/sso/start?orgId="+url.QueryEscape(h.org))
	if status != http.StatusFound || headers.Get("Cache-Control") != "no-store" ||
		!bytes.Contains(body, []byte("Continue")) {
		t.Fatalf("start: %d headers=%v body=%s", status, headers, body)
	}
	location, err := url.Parse(headers.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	query := location.Query()
	if location.Scheme != "https" || location.Host != "api.workos.com" || location.Path != "/sso/authorize" ||
		query.Get("client_id") != "client_start_test" || query.Get("connection") != "conn_start" ||
		query.Get("redirect_uri") != "https://api.example.com/auth/sso/callback" || query.Get("response_type") != "code" {
		t.Fatalf("authorize redirect: %s", location)
	}
	envelope, err := ssostate.Verify(query.Get("state"))
	if err != nil || envelope.Payload.OrgID != h.org || len(envelope.Payload.Nonce) != 32 ||
		envelope.Payload.CallbackURL != "https://api.example.com/auth/sso/callback" {
		t.Fatalf("state: envelope=%+v err=%v", envelope, err)
	}
	var nonceRows, audits int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM sso_state_nonces
		WHERE org_id = $1 AND nonce = $2 AND expires_at > now()`, h.org, envelope.Payload.Nonce).Scan(&nonceRows); err != nil || nonceRows != 1 {
		t.Fatalf("nonce row: count=%d err=%v", nonceRows, err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND user_id = 'sso' AND action = 'auth.sso.start' AND target_id = $2`, h.org, connectionID).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("start audit: count=%d err=%v", audits, err)
	}

	if status, _, raw := callSsoWithoutFollowing(t, h, "/auth/sso/start"); status != http.StatusBadRequest || !strings.Contains(string(raw), "sso_org_id_required") {
		t.Fatalf("missing org: %d %s", status, raw)
	}
	t.Setenv("JANUSLY_SSO_CALLBACK_URL", "")
	if status, _, raw := callSsoWithoutFollowing(t, h, "/auth/sso/start?orgId="+url.QueryEscape(h.org)); status != http.StatusInternalServerError || !strings.Contains(string(raw), "sso_callback_not_configured") {
		t.Fatalf("missing callback: %d %s", status, raw)
	}
	t.Setenv("JANUSLY_SSO_CALLBACK_URL", "https://api.example.com/auth/sso/callback")
	if status, _, raw := callSsoWithoutFollowing(t, h, "/auth/sso/start?orgId=missing-org"); status != http.StatusNotFound || !strings.Contains(string(raw), "sso_no_active_connection") {
		t.Fatalf("missing connection: %d %s", status, raw)
	}
}

func TestSsoCallbackAtomicallyProvisionsMembershipAuditAndSession(t *testing.T) {
	const callbackURL = "https://api.example.com/auth/sso/callback"
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "sso-callback-success-secret")
	t.Setenv("JANUSLY_SSO_CALLBACK_URL", callbackURL)
	t.Setenv("JANUSLY_WEB_BASE_URL", "https://app.example.com/")
	pool := testPool(t)
	orgID := "callback-success-" + uuid.NewString()
	connectionID := "conn_success_" + uuid.NewString()
	connectionRowID := seedSsoConnection(t, pool, orgID, connectionID)
	if err := store.New(pool).UpsertOrgConfigValue(t.Context(), store.UpsertOrgConfigValueParams{
		ID: uuid.NewString(), OrgID: orgID, Key: "auth.sessionTtlSeconds",
		ValueJson: []byte(`1800`), Category: "auth", Description: "test",
		ValueType: "number", UpdatedBy: pgtype.Text{String: "tester", Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	client := &stubWorkOSClient{profile: workos.Profile{
		ID: "workos-user-" + uuid.NewString(), Email: "alice@acme.com", ConnectionID: connectionID,
	}}
	server := newPublicSsoServer(t, pool, client, nil)
	state, nonce := issueCallbackState(t, pool, orgID, callbackURL, true)
	path := "/auth/sso/callback?code=code_success&state=" + url.QueryEscape(state)
	status, headers, body := callPublicSso(t, server.URL, path, nonce)
	if status != http.StatusFound || headers.Get("Location") != "https://app.example.com/auth/sso/complete" ||
		!strings.Contains(headers.Get("Set-Cookie"), browsersession.CookieName+"=") ||
		strings.Contains(headers.Get("Location"), browsersession.CookieName) || len(body) != 0 {
		t.Fatalf("callback: status=%d headers=%v body=%+v", status, headers, body)
	}

	var memberEmail, role string
	var invitedBy pgtype.Text
	if err := pool.QueryRow(t.Context(), `SELECT email, role, invited_by FROM org_members
		WHERE org_id = $1 AND user_id = $2`, orgID, client.profile.ID).Scan(&memberEmail, &role, &invitedBy); err != nil ||
		memberEmail != "alice@acme.com" || role != "viewer" || invitedBy.Valid {
		t.Fatalf("membership: email=%q role=%q invitedBy=%+v err=%v", memberEmail, role, invitedBy, err)
	}
	var sessionID string
	var expiresAt time.Time
	if err := pool.QueryRow(t.Context(), `SELECT id, expires_at FROM auth_sessions
		WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL`, orgID, client.profile.ID).Scan(&sessionID, &expiresAt); err != nil {
		t.Fatalf("session: %v", err)
	}
	remaining := time.Until(expiresAt)
	if remaining < 29*time.Minute || remaining > 31*time.Minute {
		t.Fatalf("policy TTL = %v", remaining)
	}
	responseCookie := (&http.Response{Header: headers}).Cookies()[0]
	request := httptest.NewRequest(http.MethodGet, "/auth/session", nil)
	request.AddCookie(responseCookie)
	if got := browsersession.ReadSessionID(request); got != sessionID {
		t.Fatalf("opaque cookie resolves %q, want %q", got, sessionID)
	}
	var loginAudits int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND user_id = $2 AND action = 'auth.sso.login'
		  AND target_id = $3`, orgID, client.profile.ID, connectionRowID).Scan(&loginAudits); err != nil || loginAudits != 1 {
		t.Fatalf("login audit: count=%d err=%v", loginAudits, err)
	}
	if client.exchangeCalls != 1 {
		t.Fatalf("exchange calls = %d", client.exchangeCalls)
	}

	// A successful callback consumes the nonce; replay never reaches WorkOS or
	// creates another durable session.
	replayStatus, _, replayBody := callPublicSso(t, server.URL, path, nonce)
	if replayStatus != http.StatusBadRequest || replayBody["code"] != "sso_invalid_state" || client.exchangeCalls != 1 {
		t.Fatalf("replay: status=%d body=%+v calls=%d", replayStatus, replayBody, client.exchangeCalls)
	}
	var sessions int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM auth_sessions
		WHERE org_id = $1 AND user_id = $2`, orgID, client.profile.ID).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("session replay count=%d err=%v", sessions, err)
	}
}

func TestSsoCallbackRejectsStateConnectionAndPolicyBeforeProvisioning(t *testing.T) {
	const callbackURL = "https://api.example.com/auth/sso/callback"
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "sso-callback-rejection-secret")
	t.Setenv("JANUSLY_SSO_CALLBACK_URL", callbackURL)
	t.Setenv("JANUSLY_WEB_BASE_URL", "https://app.example.com")
	pool := testPool(t)

	t.Run("tampered state", func(t *testing.T) {
		client := &stubWorkOSClient{}
		server := newPublicSsoServer(t, pool, client, nil)
		status, _, body := callPublicSso(t, server.URL, "/auth/sso/callback?code=code&state=tampered")
		if status != http.StatusBadRequest || body["code"] != "sso_invalid_state" || client.exchangeCalls != 0 {
			t.Fatalf("tampered: %d %+v calls=%d", status, body, client.exchangeCalls)
		}
		var audits int
		_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
			WHERE org_id = 'default' AND action = 'auth.sso.state_invalid'
			  AND metadata->>'reason' = 'invalid_signature_or_expiry'`).Scan(&audits)
		if audits == 0 {
			t.Fatal("tampered state must leave a defensive audit")
		}
	})

	t.Run("callback binding", func(t *testing.T) {
		orgID := "callback-binding-" + uuid.NewString()
		state, nonce := issueCallbackState(t, pool, orgID, "https://old.example.com/callback", true)
		client := &stubWorkOSClient{}
		server := newPublicSsoServer(t, pool, client, nil)
		status, _, body := callPublicSso(t, server.URL, "/auth/sso/callback?code=code&state="+url.QueryEscape(state), nonce)
		if status != http.StatusBadRequest || body["code"] != "sso_invalid_state" || client.exchangeCalls != 0 {
			t.Fatalf("binding: %d %+v calls=%d", status, body, client.exchangeCalls)
		}
		var nonces int
		_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM sso_state_nonces WHERE org_id = $1`, orgID).Scan(&nonces)
		if nonces != 1 {
			t.Fatalf("callback mismatch must reject before nonce consumption: %d", nonces)
		}
	})

	t.Run("connection binding", func(t *testing.T) {
		orgID := "connection-binding-" + uuid.NewString()
		seedSsoConnection(t, pool, orgID, "conn_expected")
		state, nonce := issueCallbackState(t, pool, orgID, callbackURL, true)
		client := &stubWorkOSClient{profile: workos.Profile{
			ID: "mismatch-user", Email: "mismatch@acme.com", ConnectionID: "conn_other",
		}}
		server := newPublicSsoServer(t, pool, client, nil)
		status, _, body := callPublicSso(t, server.URL, "/auth/sso/callback?code=code&state="+url.QueryEscape(state), nonce)
		if status != http.StatusBadRequest || body["code"] != "sso_connection_mismatch" || client.exchangeCalls != 1 {
			t.Fatalf("connection: %d %+v calls=%d", status, body, client.exchangeCalls)
		}
		var members int
		_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM org_members WHERE org_id = $1`, orgID).Scan(&members)
		if members != 0 {
			t.Fatalf("connection mismatch provisioned %d members", members)
		}
	})

	t.Run("allowed domain policy", func(t *testing.T) {
		orgID := "callback-policy-" + uuid.NewString()
		connectionID := "conn_policy_" + uuid.NewString()
		seedSsoConnection(t, pool, orgID, connectionID)
		if err := store.New(pool).UpsertOrgConfigValue(t.Context(), store.UpsertOrgConfigValueParams{
			ID: uuid.NewString(), OrgID: orgID, Key: "auth.allowedEmailDomains",
			ValueJson: []byte(`"acme.com"`), Category: "auth", Description: "test",
			ValueType: "string", UpdatedBy: pgtype.Text{String: "tester", Valid: true},
		}); err != nil {
			t.Fatal(err)
		}
		state, nonce := issueCallbackState(t, pool, orgID, callbackURL, true)
		client := &stubWorkOSClient{profile: workos.Profile{
			ID: "policy-user", Email: "bob@partner.example", ConnectionID: connectionID,
		}}
		server := newPublicSsoServer(t, pool, client, nil)
		status, _, body := callPublicSso(t, server.URL, "/auth/sso/callback?code=code&state="+url.QueryEscape(state), nonce)
		params, _ := body["params"].(map[string]any)
		if status != http.StatusForbidden || body["code"] != "sso_policy_violation" ||
			params["policyKey"] != "auth.allowedEmailDomains" {
			t.Fatalf("policy: %d %+v", status, body)
		}
		var members, policyAudits, callbackAudits int
		_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM org_members WHERE org_id = $1`, orgID).Scan(&members)
		_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
			WHERE org_id = $1 AND action = 'auth.policy.rejected'`, orgID).Scan(&policyAudits)
		_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
			WHERE org_id = $1 AND action = 'auth.sso.callback_failed'
			  AND metadata->>'reason' = 'policy_rejected'`, orgID).Scan(&callbackAudits)
		if members != 0 || policyAudits != 1 || callbackAudits != 1 {
			t.Fatalf("policy effects: members=%d policyAudits=%d callbackAudits=%d", members, policyAudits, callbackAudits)
		}
	})
}

func TestSsoCallbackRollsBackMembershipAndLoginAuditWhenSessionInsertFails(t *testing.T) {
	const callbackURL = "https://api.example.com/auth/sso/callback"
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "sso-callback-rollback-secret")
	t.Setenv("JANUSLY_SSO_CALLBACK_URL", callbackURL)
	t.Setenv("JANUSLY_WEB_BASE_URL", "https://app.example.com")
	pool := testPool(t)
	orgID := "callback-rollback-" + uuid.NewString()
	connectionID := "conn_rollback_" + uuid.NewString()
	connectionRowID := seedSsoConnection(t, pool, orgID, connectionID)
	forcedID := uuid.NewString()
	if _, err := store.New(pool).CreateAuthSession(t.Context(), store.CreateAuthSessionParams{
		ID: forcedID, UserID: "existing-user", Email: "existing@example.com",
		OrgID: orgID, ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	client := &stubWorkOSClient{profile: workos.Profile{
		ID: "rollback-user-" + uuid.NewString(), Email: "rollback@acme.com", ConnectionID: connectionID,
	}}
	server := newPublicSsoServer(t, pool, client, func() string { return forcedID })
	state, nonce := issueCallbackState(t, pool, orgID, callbackURL, true)
	status, _, body := callPublicSso(t, server.URL,
		"/auth/sso/callback?code=code&state="+url.QueryEscape(state), nonce)
	if status != http.StatusInternalServerError || body["code"] != "sso_membership_persist_failed" {
		t.Fatalf("rollback response: %d %+v", status, body)
	}
	var members, loginAudits, failureAudits int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM org_members
		WHERE org_id = $1 AND user_id = $2`, orgID, client.profile.ID).Scan(&members)
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND user_id = $2 AND action = 'auth.sso.login'`, orgID, client.profile.ID).Scan(&loginAudits)
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND user_id = $2 AND action = 'auth.sso.callback_failed'
		  AND target_id = $3 AND metadata->>'reason' = 'membership_persist_failed'`,
		orgID, client.profile.ID, connectionRowID).Scan(&failureAudits)
	if members != 0 || loginAudits != 0 || failureAudits != 1 {
		t.Fatalf("rollback effects: members=%d loginAudits=%d failureAudits=%d", members, loginAudits, failureAudits)
	}
}

func TestSsoCallbackMapsExchangeFailuresWithoutProvisioning(t *testing.T) {
	const callbackURL = "https://api.example.com/auth/sso/callback"
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "sso-callback-exchange-secret")
	t.Setenv("JANUSLY_SSO_CALLBACK_URL", callbackURL)
	t.Setenv("JANUSLY_WEB_BASE_URL", "https://app.example.com")
	pool := testPool(t)
	orgID := "callback-exchange-" + uuid.NewString()
	connectionID := "conn_exchange_" + uuid.NewString()
	seedSsoConnection(t, pool, orgID, connectionID)
	client := &stubWorkOSClient{exchangeError: errors.New("network unavailable")}
	server := newPublicSsoServer(t, pool, client, nil)
	state, nonce := issueCallbackState(t, pool, orgID, callbackURL, true)
	status, _, body := callPublicSso(t, server.URL,
		"/auth/sso/callback?code=code&state="+url.QueryEscape(state), nonce)
	if status != http.StatusBadRequest || body["code"] != "sso_exchange_failed" {
		t.Fatalf("exchange: %d %+v", status, body)
	}
	var members, audits int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM org_members WHERE org_id = $1`, orgID).Scan(&members)
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action = 'auth.sso.callback_failed' AND metadata->>'reason' = 'exchange_failed'`, orgID).Scan(&audits)
	if members != 0 || audits != 1 {
		t.Fatalf("exchange effects: members=%d audits=%d", members, audits)
	}
}

// Login-CSRF: an attacker completes the authorize step themselves, then
// hands the resulting callback URL to a victim. The state signature is
// genuine and the nonce is unused, so signature + single-use checks both
// pass — only the browser binding stops the victim's browser from being
// logged into the ATTACKER's identity. The nonce must survive so the
// legitimate browser can still finish its own flow.
func TestSsoCallbackRequiresTheBrowserThatStartedTheFlow(t *testing.T) {
	const callbackURL = "https://api.example.com/auth/sso/callback"
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "sso-binding-secret")
	t.Setenv("JANUSLY_SSO_CALLBACK_URL", callbackURL)
	t.Setenv("JANUSLY_WEB_BASE_URL", "https://app.example.com/")
	pool := testPool(t)
	orgID := "callback-binding-" + uuid.NewString()
	connectionID := "conn_binding_" + uuid.NewString()
	seedSsoConnection(t, pool, orgID, connectionID)
	server := newPublicSsoServer(t, pool, &stubWorkOSClient{
		profile: workos.Profile{
			ID: "wos_binding_" + uuid.NewString(), Email: "victim@acme.com",
			ConnectionID: connectionID,
		},
	}, nil)

	state, nonce := issueCallbackState(t, pool, orgID, callbackURL, true)
	path := "/auth/sso/callback?code=code_success&state=" + url.QueryEscape(state)

	// No cookie at all — the victim's browser never visited startSso.
	status, _, body := callPublicSso(t, server.URL, path)
	if status != http.StatusBadRequest || body["code"] != "sso_invalid_state" {
		t.Fatalf("callback without the binding must be rejected: %d %+v", status, body)
	}
	// A cookie from a DIFFERENT flow must not satisfy the binding either.
	status, _, body = callPublicSso(t, server.URL, path, uuid.NewString())
	if status != http.StatusBadRequest || body["code"] != "sso_invalid_state" {
		t.Fatalf("callback with a foreign binding must be rejected: %d %+v", status, body)
	}

	// Neither rejection may burn the nonce or provision anything.
	var nonces, members int
	_ = pool.QueryRow(t.Context(),
		`SELECT count(*) FROM sso_state_nonces WHERE org_id = $1`, orgID).Scan(&nonces)
	_ = pool.QueryRow(t.Context(),
		`SELECT count(*) FROM org_members WHERE org_id = $1`, orgID).Scan(&members)
	if nonces != 1 || members != 0 {
		t.Fatalf("a blocked callback must not consume state or provision: nonces=%d members=%d", nonces, members)
	}

	// The browser that actually started the flow still completes it.
	if status, _, body = callPublicSso(t, server.URL, path, nonce); status != http.StatusFound {
		t.Fatalf("the initiating browser must still succeed: %d %+v", status, body)
	}
}
