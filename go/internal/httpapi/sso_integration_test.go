//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/go/internal/ssostate"
)

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
