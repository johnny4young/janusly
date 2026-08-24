//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/browsersession"
	"github.com/johnny4young/janusly/internal/store"
)

func callBrowserSession(t *testing.T, h *apiHarness, method, path, cookie string, body any, headers map[string]string) apiResponse {
	t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("call %s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	parsed := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&parsed)
	return apiResponse{status: res.StatusCode, headers: res.Header, body: parsed}
}

func sessionCookiePair(setCookie string) string {
	pair, _, _ := strings.Cut(setCookie, ";")
	return pair
}

func TestBrowserSessionRoutesAndIdentityDispatcher(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "http-session-test-secret")
	t.Setenv("API_ALLOWED_ORIGINS", "http://localhost:5173")
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()

	if signedOut := callBrowserSession(t, h, "GET", "/auth/session", "", nil, nil); signedOut.status != 200 || signedOut.body["authenticated"] != false {
		t.Fatalf("signed-out discovery: %d %+v", signedOut.status, signedOut.body)
	}

	userID := "browser-user-" + uuid.NewString()
	orgA := "browser-org-a-" + uuid.NewString()
	orgB := "browser-org-b-" + uuid.NewString()
	for orgID, name := range map[string]string{orgA: "Alpha Operations", orgB: "Beta Operations"} {
		if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, owner_user_id, name) VALUES ($1, $2, $3)`, orgID, "seed-owner-"+orgID, name); err != nil {
			t.Fatalf("seed organization: %v", err)
		}
	}
	for orgID, role := range map[string]string{orgA: "editor", orgB: "viewer"} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO org_members (id, org_id, user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
			uuid.NewString(), orgID, userID, "alice@example.com", role); err != nil {
			t.Fatalf("seed membership: %v", err)
		}
	}
	sessionID := uuid.NewString()
	expiresAt := time.Now().Add(30 * time.Minute)
	if _, err := store.New(pool).CreateAuthSession(ctx, store.CreateAuthSessionParams{
		ID: sessionID, UserID: userID, Email: "alice@example.com", OrgID: orgA, ExpiresAt: expiresAt,
	}); err != nil {
		t.Fatalf("create auth session: %v", err)
	}
	token, err := browsersession.CreateToken(sessionID, 1800)
	if err != nil {
		t.Fatalf("create cookie token: %v", err)
	}
	cookie := browsersession.CookieName + "=" + token.Value

	discovery := callBrowserSession(t, h, "GET", "/auth/session", cookie, nil, nil)
	if discovery.status != 200 || discovery.body["authenticated"] != true ||
		discovery.body["userId"] != userID || discovery.body["organizationId"] != orgA {
		t.Fatalf("active discovery: %d %+v", discovery.status, discovery.body)
	}
	bootstrap := callBrowserSession(t, h, "GET", "/auth/context", cookie, nil, nil)
	identity, _ := bootstrap.body["identity"].(map[string]any)
	organizations, _ := bootstrap.body["organizations"].([]any)
	if bootstrap.status != 200 || identity["mode"] != "janusly-session" ||
		bootstrap.body["currentOrganizationId"] != orgA || len(organizations) != 2 {
		t.Fatalf("session bootstrap: %d %+v", bootstrap.status, bootstrap.body)
	}

	allowedOrigin := map[string]string{"Origin": "http://localhost:5173"}
	tenantMissingMarker := callBrowserSession(t, h, "POST", "/users/me", cookie,
		map[string]any{"name": "Alice Operator"}, allowedOrigin)
	if tenantMissingMarker.status != 403 || tenantMissingMarker.body["code"] != "server_request_failed" {
		t.Fatalf("tenant mutation missing CSRF marker: %d %+v", tenantMissingMarker.status, tenantMissingMarker.body)
	}
	csrfHeaders := map[string]string{"Origin": "http://localhost:5173", browsersession.CSRFHeader: "1"}
	tenantAccepted := callBrowserSession(t, h, "POST", "/users/me", cookie,
		map[string]any{"name": "Alice Operator"}, csrfHeaders)
	if tenantAccepted.status != 200 || tenantAccepted.body["name"] != "Alice Operator" {
		t.Fatalf("tenant mutation with CSRF: %d %+v", tenantAccepted.status, tenantAccepted.body)
	}

	missingMarker := callBrowserSession(t, h, "POST", "/auth/session/organization", cookie,
		map[string]any{"organizationId": orgB}, allowedOrigin)
	if missingMarker.status != 403 || missingMarker.body["code"] != "server_request_failed" {
		t.Fatalf("missing CSRF marker: %d %+v", missingMarker.status, missingMarker.body)
	}
	foreignOrigin := callBrowserSession(t, h, "POST", "/auth/session/organization", cookie,
		map[string]any{"organizationId": orgB}, map[string]string{
			"Origin": "https://attacker.example", browsersession.CSRFHeader: "1",
		})
	if foreignOrigin.status != 403 {
		t.Fatalf("foreign origin: %d %+v", foreignOrigin.status, foreignOrigin.body)
	}
	denied := callBrowserSession(t, h, "POST", "/auth/session/organization", cookie,
		map[string]any{"organizationId": "foreign-org"}, csrfHeaders)
	if denied.status != 403 || denied.body["code"] != "organization_access_denied" {
		t.Fatalf("membership proof: %d %+v", denied.status, denied.body)
	}

	switched := callBrowserSession(t, h, "POST", "/auth/session/organization", cookie,
		map[string]any{"organizationId": orgB}, csrfHeaders)
	if switched.status != 200 || switched.body["organizationId"] != orgB || switched.headers.Get("Set-Cookie") == "" {
		t.Fatalf("organization switch: %d %+v %v", switched.status, switched.body, switched.headers)
	}
	rotatedCookie := sessionCookiePair(switched.headers.Get("Set-Cookie"))
	if got := callBrowserSession(t, h, "GET", "/auth/session", rotatedCookie, nil, nil); got.body["organizationId"] != orgB {
		t.Fatalf("rotated discovery: %+v", got.body)
	}
	active, err := store.New(pool).GetActiveAuthSession(ctx, sessionID)
	if err != nil || active.OrgID != orgB || active.ExpiresAt.Unix() != expiresAt.Unix() {
		t.Fatalf("durable switch must preserve expiry: %+v %v", active, err)
	}

	logout := callBrowserSession(t, h, "POST", "/auth/session/logout", rotatedCookie, nil, csrfHeaders)
	if logout.status != 200 || logout.body["signedOut"] != true || !strings.Contains(logout.headers.Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("logout: %d %+v %v", logout.status, logout.body, logout.headers)
	}
	if _, err := store.New(pool).GetActiveAuthSession(ctx, sessionID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("logout must revoke durable row: %v", err)
	}
	if got := callBrowserSession(t, h, "GET", "/auth/session", rotatedCookie, nil, nil); got.body["authenticated"] != false {
		t.Fatalf("revoked cookie discovery: %+v", got.body)
	}
}

func TestIdentityBootstrapAllowsZeroMemberships(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "http-session-test-secret")
	h := newAPIHarness(t)
	pool := testPool(t)
	sessionID := uuid.NewString()
	if _, err := store.New(pool).CreateAuthSession(t.Context(), store.CreateAuthSessionParams{
		ID: sessionID, UserID: "new-user-" + uuid.NewString(), Email: "new@example.com",
		OrgID: "ungranted-org-" + uuid.NewString(), ExpiresAt: time.Now().Add(10 * time.Minute),
	}); err != nil {
		t.Fatalf("create auth session: %v", err)
	}
	token, err := browsersession.CreateToken(sessionID, 600)
	if err != nil {
		t.Fatal(err)
	}
	bootstrap := callBrowserSession(t, h, "GET", "/auth/context",
		browsersession.CookieName+"="+token.Value, nil, nil)
	if bootstrap.status != 200 || bootstrap.body["needsOrganization"] != true ||
		bootstrap.body["currentOrganizationId"] != nil || bootstrap.body["selectionRequired"] != false {
		t.Fatalf("zero-membership bootstrap: %d %+v", bootstrap.status, bootstrap.body)
	}
}
