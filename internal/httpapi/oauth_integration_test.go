//go:build integration

package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/store"
)

const testIssuer = "https://janusly.example.test"

type oauthHarness struct {
	*apiHarness
	client *http.Client
}

func newOAuthHarness(t *testing.T) oauthHarness {
	t.Helper()
	options := defaultV1ServerOptionsForTest()
	options.Logger = quietTestLogger()
	options.OAuthIssuer = testIssuer
	h := newAPIHarnessWithOptions(t, false, options)
	// The limits are per client address, and every test shares one.
	if _, err := testPool(t).Exec(t.Context(), `DELETE FROM rate_limit_windows WHERE name LIKE 'oauth.%'`); err != nil {
		t.Fatal(err)
	}
	return oauthHarness{apiHarness: h, client: &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

type rawReply struct {
	status   int
	location *url.URL
	body     map[string]any
	text     string
	header   http.Header
}

func (h oauthHarness) raw(t *testing.T, method, path, contentType, body string) rawReply {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, h.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := h.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	out := rawReply{status: res.StatusCode, text: string(raw), header: res.Header}
	_ = json.Unmarshal(raw, &out.body)
	if location := res.Header.Get("Location"); location != "" {
		out.location, _ = url.Parse(location)
	}
	return out
}

func (h oauthHarness) register(t *testing.T, name string, redirects ...string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"client_name": name, "redirect_uris": redirects, "token_endpoint_auth_method": "none"})
	res := h.raw(t, "POST", "/oauth/register", "application/json", string(body))
	id, _ := res.body["client_id"].(string)
	if res.status != http.StatusCreated || !strings.HasPrefix(id, "oc_") {
		t.Fatalf("register: %d %s", res.status, res.text)
	}
	return id
}

func pkce() (verifier, challenge string) {
	verifier = strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// authorize returns the consent request id the browser is sent to.
func (h oauthHarness) authorize(t *testing.T, clientID, redirect, challenge, scope, state string) string {
	t.Helper()
	query := url.Values{"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "scope": {scope}, "state": {state},
		"resource": {testIssuer + "/mcp"}}
	res := h.raw(t, "GET", "/oauth/authorize?"+query.Encode(), "", "")
	if res.status != http.StatusFound || res.location == nil || res.location.Host != "janusly.example.test" {
		t.Fatalf("authorize: %d %s %v", res.status, res.text, res.location)
	}
	return res.location.Query().Get("oauth_request")
}

func (h oauthHarness) tokenCall(t *testing.T, form url.Values) rawReply {
	t.Helper()
	return h.raw(t, "POST", "/oauth/token", "application/x-www-form-urlencoded", form.Encode())
}

func seedOAuthPerson(t *testing.T, h *apiHarness, org, user, role string) map[string]string {
	t.Helper()
	seedMemberRow(t, testPool(t), org, user, user+"@example.test", role)
	return map[string]string{"x-user-id": user}
}

func TestOAuthFullFlowIssuesAShortLivedGrantThatRotates(t *testing.T) {
	h := newOAuthHarness(t)
	pool := testPool(t)
	as := seedOAuthPerson(t, h.apiHarness, h.org, "oauth-editor-"+uuid.NewString()[:6], "editor")

	// Discovery.
	resource := h.raw(t, "GET", "/.well-known/oauth-protected-resource/mcp", "", "")
	server := h.raw(t, "GET", "/.well-known/oauth-authorization-server", "", "")
	if resource.body["resource"] != testIssuer+"/mcp" || server.body["issuer"] != testIssuer ||
		server.body["token_endpoint"] != testIssuer+"/oauth/token" || !strings.Contains(server.text, `"S256"`) ||
		strings.Contains(server.text, "report") {
		t.Fatalf("metadata: %s %s", resource.text, server.text)
	}

	redirect := "http://127.0.0.1:53211/callback"
	clientID := h.register(t, "Claude Code", "http://127.0.0.1/callback")
	verifier, challenge := pkce()
	requestID := h.authorize(t, clientID, redirect, challenge, "janusly:read janusly:propose janusly:operate", "st-1")

	view := h.callWithHeaders("GET", "/oauth/requests/"+requestID, nil, "", as)
	if view.status != 200 || view.body["clientName"] != "Claude Code" || view.body["redirectHost"] != "127.0.0.1:53211" ||
		view.body["redirectIsLocal"] != true || len(view.body["capabilities"].([]any)) != 3 {
		t.Fatalf("consent view: %d %v", view.status, view.body)
	}
	// The person may grant less than was asked, never more.
	if res := h.callWithHeaders("POST", "/oauth/requests/"+requestID+"/decision",
		map[string]any{"approve": true, "capabilities": []string{"read", "publish"}}, "", as); res.status != 400 || res.body["code"] != "capability_not_requested" {
		t.Fatalf("granting an unrequested capability: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/oauth/requests/"+requestID+"/decision",
		map[string]any{"approve": true, "capabilities": []string{"report"}}, "", as); res.status != 400 {
		t.Fatalf("granting report: %d %v", res.status, res.body)
	}
	decided := h.callWithHeaders("POST", "/oauth/requests/"+requestID+"/decision",
		map[string]any{"approve": true, "capabilities": []string{"read", "propose"}, "expiresInDays": 7}, "", as)
	back, _ := url.Parse(decided.body["redirectTo"].(string))
	code := back.Query().Get("code")
	if decided.status != 200 || back.Host != "127.0.0.1:53211" || back.Query().Get("state") != "st-1" ||
		back.Query().Get("iss") != testIssuer || !strings.HasPrefix(code, "jly_code_") {
		t.Fatalf("decision: %d %v", decided.status, decided.body)
	}
	if again := h.callWithHeaders("POST", "/oauth/requests/"+requestID+"/decision", map[string]any{"approve": true}, "", as); again.status != 404 {
		t.Fatalf("a request was decided twice: %d", again.status)
	}

	exchange := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier},
		"client_id": {clientID}, "redirect_uri": {redirect}, "resource": {testIssuer + "/mcp"}}
	tokens := h.tokenCall(t, exchange)
	access, _ := tokens.body["access_token"].(string)
	refresh, _ := tokens.body["refresh_token"].(string)
	if tokens.status != 200 || !strings.HasPrefix(access, "jly_agent_") || !strings.HasPrefix(refresh, "jly_refresh_") ||
		tokens.body["expires_in"] != float64(900) || tokens.body["scope"] != "janusly:read janusly:propose" ||
		tokens.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("token: %d %s", tokens.status, tokens.text)
	}

	// The grant is an ordinary agent client: same resolver, same authority.
	resolver := agentclient.Resolver{Pool: pool}
	principal, err := resolver.Resolve(t.Context(), access)
	if err != nil || principal.OrgID != h.org || principal.CreatedBy != as["x-user-id"] ||
		principal.Has(agentclient.CapabilityOperate) || principal.Has(agentclient.CapabilityReport) || !principal.Has(agentclient.CapabilityPropose) {
		t.Fatalf("resolved principal: %+v %v", principal, err)
	}
	var stored string
	if err := pool.QueryRow(t.Context(), `SELECT coalesce(string_agg(row_to_json(r)::text, ' '), '') FROM (
		SELECT * FROM oauth_authorization_requests WHERE id = $1) r`, requestID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, code) || strings.Contains(stored, access) || strings.Contains(stored, refresh) {
		t.Fatalf("a code or token was stored in clear: %s", stored)
	}

	// Refresh rotates both tokens; the old access token stops working.
	rotated := h.tokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {clientID}})
	access2, _ := rotated.body["access_token"].(string)
	refresh2, _ := rotated.body["refresh_token"].(string)
	if rotated.status != 200 || access2 == access || refresh2 == refresh {
		t.Fatalf("refresh: %d %s", rotated.status, rotated.text)
	}
	if _, err := resolver.Resolve(t.Context(), access); err == nil {
		t.Fatal("the rotated-away access token still resolves")
	}
	if _, err := resolver.Resolve(t.Context(), access2); err != nil {
		t.Fatalf("new access token: %v", err)
	}
	// An access token past its 15 minutes is refused even though the client lives on.
	if _, err := pool.Exec(t.Context(), `UPDATE agent_clients SET access_expires_at = now() - interval '1 second' WHERE id = $1`, principal.ClientID); err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.Resolve(t.Context(), access2); err == nil {
		t.Fatal("an expired access token still resolves")
	}
	// Refreshing does not extend the client's life.
	var before, after string
	_ = pool.QueryRow(t.Context(), `SELECT expires_at::text FROM agent_clients WHERE id = $1`, principal.ClientID).Scan(&before)
	again := h.tokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh2}, "client_id": {clientID}})
	_ = pool.QueryRow(t.Context(), `SELECT expires_at::text FROM agent_clients WHERE id = $1`, principal.ClientID).Scan(&after)
	if again.status != 200 || before != after {
		t.Fatalf("refresh moved the client's expiry: %s -> %s (%d)", before, after, again.status)
	}

	// A client that retries the refresh it just made is not treated as a thief.
	retry := h.tokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh2}, "client_id": {clientID}})
	access3, _ := again.body["access_token"].(string)
	if retry.status != 400 || retry.body["error"] != "invalid_grant" {
		t.Fatalf("retried refresh: %d %s", retry.status, retry.text)
	}
	if _, err := resolver.Resolve(t.Context(), access3); err != nil {
		t.Fatalf("a retried refresh ended the grant: %v", err)
	}
	// Any refresh token rotated away, however many rotations ago, ends the
	// grant when it comes back later: someone else holds it.
	refresh3, _ := again.body["refresh_token"].(string)
	fourth := h.tokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh3}, "client_id": {clientID}})
	access4, _ := fourth.body["access_token"].(string)
	if fourth.status != 200 {
		t.Fatalf("third rotation: %d %s", fourth.status, fourth.text)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_refresh_history SET rotated_at = now() - interval '5 minutes' WHERE agent_client_id = $1`, principal.ClientID); err != nil {
		t.Fatal(err)
	}
	reuse := h.tokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {clientID}})
	if reuse.status != 400 || reuse.body["error"] != "invalid_grant" {
		t.Fatalf("reused refresh token: %d %s", reuse.status, reuse.text)
	}
	if _, err := resolver.Resolve(t.Context(), access4); err == nil {
		t.Fatal("the grant survived a refresh token from three rotations ago")
	}
	var audited int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'oauth.refresh_reused' AND target_id = $2`,
		h.org, principal.ClientID).Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("refresh reuse audit: %d %v", audited, err)
	}
	var history string
	_ = pool.QueryRow(t.Context(), `SELECT coalesce(string_agg(encode(digest, 'escape'), ' '), '') FROM oauth_refresh_history WHERE agent_client_id = $1`, principal.ClientID).Scan(&history)
	if strings.Contains(history, "jly_refresh_") {
		t.Fatal("a refresh token was stored in clear")
	}
	// An OAuth client is never rotated into a static token, by the route or the query.
	if _, err := agentclient.Rotate(t.Context(), store.New(pool), h.org, principal.ClientID, time.Now(), 30); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("the store rotated an OAuth client: %v", err)
	}
	if res := h.callWithHeaders("POST", "/agent-clients/"+principal.ClientID+"/rotate", nil, "", as); res.status != 409 {
		t.Fatalf("rotating an OAuth client: %d %v", res.status, res.body)
	}
}

func TestOAuthRefusesBadRequestsWithoutLeakingOrRedirecting(t *testing.T) {
	h := newOAuthHarness(t)
	as := seedOAuthPerson(t, h.apiHarness, h.org, "oauth-editor-"+uuid.NewString()[:6], "editor")
	redirect := "https://client.example.test/cb"
	clientID := h.register(t, "Client", redirect)
	verifier, challenge := pkce()

	// Registration: only https or loopback http, no fragments, public clients only.
	for name, body := range map[string]string{
		"plain http":     `{"redirect_uris":["http://client.example.test/cb"]}`,
		"private scheme": `{"redirect_uris":["cursor://anysphere.cursor/cb"]}`,
		"fragment":       `{"redirect_uris":["https://x.example/cb#frag"]}`,
		"look-alike":     `{"redirect_uris":["https://cl\u0430ude.ai/cb"]}`,
		"bidi host":      `{"redirect_uris":["https://evil\u202e.example/cb"]}`,
		"upper host":     `{"redirect_uris":["https://Client.Example.test/cb"]}`,
		"credentials":    `{"redirect_uris":["https://user:pw@x.example/cb"]}`,
		"none":           `{"redirect_uris":[]}`,
		"confidential":   `{"redirect_uris":["https://x.example/cb"],"token_endpoint_auth_method":"client_secret_basic"}`,
		"implicit":       `{"redirect_uris":["https://x.example/cb"],"grant_types":["implicit"]}`,
		"not json":       `nope`,
	} {
		// The per-address limit is not what this loop is about.
		if _, err := testPool(t).Exec(t.Context(), `DELETE FROM rate_limit_windows WHERE name LIKE 'oauth.%'`); err != nil {
			t.Fatal(err)
		}
		if res := h.raw(t, "POST", "/oauth/register", "application/json", body); res.status != 400 {
			t.Fatalf("register %s: %d %s", name, res.status, res.text)
		}
	}

	// A bad client or redirect is answered here, never redirected.
	base := url.Values{"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "state": {"s"}}
	with := func(key, value string) string {
		query := url.Values{}
		for k, v := range base {
			query[k] = v
		}
		if value == "" {
			query.Del(key)
		} else {
			query.Set(key, value)
		}
		return "/oauth/authorize?" + query.Encode()
	}
	for name, path := range map[string]string{
		"unknown client":  with("client_id", "oc_"+uuid.NewString()),
		"other redirect":  with("redirect_uri", "https://evil.example.test/cb"),
		"redirect prefix": with("redirect_uri", redirect+"/extra"),
	} {
		res := h.raw(t, "GET", path, "", "")
		if res.status != 400 || res.location != nil {
			t.Fatalf("%s: %d %v", name, res.status, res.location)
		}
	}
	// Other errors go back to the registered redirect with the state.
	for name, want := range map[string][2]string{
		with("response_type", "token"):                     {"unsupported_response_type", ""},
		with("code_challenge_method", "plain"):             {"invalid_request", ""},
		with("code_challenge", ""):                         {"invalid_request", ""},
		with("state", ""):                                  {"invalid_request", ""},
		with("scope", "janusly:report"):                    {"invalid_scope", ""},
		with("scope", "janusly:read admin"):                {"invalid_scope", ""},
		with("resource", "https://other.example.test/mcp"): {"invalid_target", ""},
	} {
		res := h.raw(t, "GET", name, "", "")
		if res.status != 302 || res.location == nil || res.location.Host != "client.example.test" || res.location.Query().Get("error") != want[0] {
			t.Fatalf("%s: %d %v", name, res.status, res.location)
		}
	}
	if res := h.raw(t, "GET", with("state", "s"), "", ""); res.header.Get("Content-Security-Policy") != "frame-ancestors 'none'" {
		t.Fatalf("authorize is frameable: %v", res.header)
	}

	// A denial goes back as access_denied and creates nothing.
	requestID := h.authorize(t, clientID, redirect, challenge, "", "s-deny")
	denied := h.callWithHeaders("POST", "/oauth/requests/"+requestID+"/decision", map[string]any{"approve": false}, "", as)
	if back, _ := url.Parse(denied.body["redirectTo"].(string)); back.Query().Get("error") != "access_denied" || back.Query().Get("code") != "" {
		t.Fatalf("denial: %v", denied.body)
	}

	// Token endpoint: every wrong input is the same invalid_grant.
	requestID = h.authorize(t, clientID, redirect, challenge, "", "s2")
	decided := h.callWithHeaders("POST", "/oauth/requests/"+requestID+"/decision", map[string]any{"approve": true}, "", as)
	back, _ := url.Parse(decided.body["redirectTo"].(string))
	code := back.Query().Get("code")
	good := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier},
		"client_id": {clientID}, "redirect_uri": {redirect}}
	mutate := func(key, value string) url.Values {
		form := url.Values{}
		for k, v := range good {
			form[k] = v
		}
		form.Set(key, value)
		return form
	}
	otherVerifier, _ := pkce()
	for name, form := range map[string]url.Values{
		"wrong verifier": mutate("code_verifier", otherVerifier),
		"short verifier": mutate("code_verifier", "abc"),
		"other client":   mutate("client_id", h.register(t, "Other", redirect)),
		"other redirect": mutate("redirect_uri", "https://client.example.test/other"),
		"other resource": mutate("resource", "https://other.example.test/mcp"),
		"unknown code":   mutate("code", "jly_code_"+strings.Repeat("A", 43)),
	} {
		res := h.tokenCall(t, form)
		if res.status != 400 || res.body["error"] != "invalid_grant" || strings.Contains(res.text, code) {
			t.Fatalf("%s: %d %s", name, res.status, res.text)
		}
	}
	if res := h.tokenCall(t, mutate("grant_type", "password")); res.body["error"] != "unsupported_grant_type" {
		t.Fatalf("grant type: %s", res.text)
	}
	// The code still works after those failures, exactly once; a replay ends the grant.
	first := h.tokenCall(t, good)
	access, _ := first.body["access_token"].(string)
	if first.status != 200 {
		t.Fatalf("exchange: %d %s", first.status, first.text)
	}
	// A retried exchange is refused without ending the grant; a later replay ends it.
	// (A retry that cannot prove it is the same client is covered below.)
	if retry := h.tokenCall(t, good); retry.status != 400 || retry.body["error"] != "invalid_grant" {
		t.Fatalf("code retry: %d %s", retry.status, retry.text)
	}
	if _, err := (agentclient.Resolver{Pool: testPool(t)}).Resolve(t.Context(), access); err != nil {
		t.Fatalf("a retried exchange ended the grant: %v", err)
	}
	if _, err := testPool(t).Exec(t.Context(), `UPDATE oauth_authorization_requests SET code_used_at = now() - interval '2 minutes' WHERE id = $1`, requestID); err != nil {
		t.Fatal(err)
	}
	if replay := h.tokenCall(t, good); replay.status != 400 || replay.body["error"] != "invalid_grant" {
		t.Fatalf("code replay: %d %s", replay.status, replay.text)
	}
	if _, err := (agentclient.Resolver{Pool: testPool(t)}).Resolve(t.Context(), access); err == nil {
		t.Fatal("the grant survived a replayed code")
	}
	// Inside the grace window, a replay without the right verifier is still a leak.
	requestID = h.authorize(t, clientID, redirect, challenge, "", "s-leak")
	decided = h.callWithHeaders("POST", "/oauth/requests/"+requestID+"/decision", map[string]any{"approve": true}, "", as)
	back, _ = url.Parse(decided.body["redirectTo"].(string))
	leaked := h.tokenCall(t, mutate("code", back.Query().Get("code")))
	leakedAccess, _ := leaked.body["access_token"].(string)
	stolen := mutate("code", back.Query().Get("code"))
	stolen.Set("code_verifier", otherVerifier)
	if res := h.tokenCall(t, stolen); leaked.status != 200 || res.status != 400 {
		t.Fatalf("stolen code replay: %d %d", leaked.status, res.status)
	}
	if _, err := (agentclient.Resolver{Pool: testPool(t)}).Resolve(t.Context(), leakedAccess); err == nil {
		t.Fatal("a code replayed without its verifier did not end the grant")
	}
	// One client cannot pile up unanswered requests.
	if _, err := testPool(t).Exec(t.Context(), `DELETE FROM rate_limit_windows WHERE name LIKE 'oauth.%'`); err != nil {
		t.Fatal(err)
	}
	capped := false
	for range 21 {
		if res := h.raw(t, "GET", with("state", "pile"), "", ""); res.location != nil && res.location.Query().Get("error") == "temporarily_unavailable" {
			capped = true
			break
		}
	}
	if !capped {
		t.Fatal("one client piled up more than 20 unanswered requests")
	}
	otherClient := h.register(t, "Unaffected", redirect)
	if h.authorize(t, otherClient, redirect, challenge, "", "ok") == "" {
		t.Fatal("another client was crowded out")
	}

	// An expired code is refused.
	if _, err := testPool(t).Exec(t.Context(), `DELETE FROM oauth_authorization_requests WHERE oauth_client_id = $1 AND status = 'pending'`, clientID); err != nil {
		t.Fatal(err)
	}
	requestID = h.authorize(t, clientID, redirect, challenge, "", "s3")
	decided = h.callWithHeaders("POST", "/oauth/requests/"+requestID+"/decision", map[string]any{"approve": true}, "", as)
	back, _ = url.Parse(decided.body["redirectTo"].(string))
	if _, err := testPool(t).Exec(t.Context(), `UPDATE oauth_authorization_requests SET code_expires_at = now() - interval '1 second' WHERE id = $1`, requestID); err != nil {
		t.Fatal(err)
	}
	if res := h.tokenCall(t, mutate("code", back.Query().Get("code"))); res.status != 400 {
		t.Fatalf("expired code: %d %s", res.status, res.text)
	}
}

// Isolation: consent binds the grant to the deciding person's organization and
// grant; nothing in the OAuth requests can move it elsewhere.
func TestOAuthIsolationMatrix(t *testing.T) {
	t.Setenv("JANUSLY_API_SERVICE_TOKEN", "svc-oauth-token")
	h := newOAuthHarness(t)
	other := "other-org-" + uuid.NewString()[:8]
	editorA := seedOAuthPerson(t, h.apiHarness, h.org, "a-editor-"+uuid.NewString()[:6], "editor")
	viewerA := seedOAuthPerson(t, h.apiHarness, h.org, "a-viewer-"+uuid.NewString()[:6], "viewer")
	editorB := seedOAuthPerson(t, h.apiHarness, other, "b-editor-"+uuid.NewString()[:6], "editor")
	redirect := "https://client.example.test/cb"
	clientID := h.register(t, "Client", redirect)
	verifier, challenge := pkce()
	requestID := h.authorize(t, clientID, redirect, challenge, "janusly:operate", "s")
	path := "/oauth/requests/" + requestID

	if res := h.callWithHeaders("GET", path, nil, "", viewerA); res.status != 403 {
		t.Fatalf("viewer read a consent request: %d", res.status)
	}
	if res := h.callWithHeaders("POST", path+"/decision", map[string]any{"approve": true}, "", viewerA); res.status != 403 {
		t.Fatalf("viewer approved: %d", res.status)
	}
	if res := h.callWithHeaders("POST", path+"/decision", map[string]any{"approve": true}, "", map[string]string{
		"x-user-id": editorA["x-user-id"], "Authorization": "Bearer svc-oauth-token"}); res.status != 403 {
		t.Fatalf("service token approved: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", path+"/decision", map[string]any{"approve": true}, "", map[string]string{
		"Authorization": "Bearer jly_agent_" + strings.Repeat("A", 43)}); res.status != 401 && res.status != 403 {
		t.Fatalf("agent token approved: %d", res.status)
	}
	if res := h.callWithHeaders("GET", "/oauth/requests/"+uuid.NewString(), nil, "", editorA); res.status != 404 {
		t.Fatalf("unknown request: %d", res.status)
	}

	// B's editor approves in B: the grant lives in B, owned by B's editor.
	decided := h.callWithHeaders("POST", path+"/decision", map[string]any{"approve": true, "capabilities": []string{"operate"}}, other, editorB)
	back, _ := url.Parse(decided.body["redirectTo"].(string))
	tokens := h.tokenCall(t, url.Values{"grant_type": {"authorization_code"}, "code": {back.Query().Get("code")},
		"code_verifier": {verifier}, "client_id": {clientID}, "redirect_uri": {redirect}})
	access, _ := tokens.body["access_token"].(string)
	principal, err := (agentclient.Resolver{Pool: testPool(t)}).Resolve(t.Context(), access)
	if err != nil || principal.OrgID != other || principal.CreatedBy != editorB["x-user-id"] {
		t.Fatalf("grant crossed organizations: %+v %v", principal, err)
	}
	// A's people cannot see or revoke B's grant; B's can.
	if res := h.callWithHeaders("POST", "/agent-clients/"+principal.ClientID+"/revoke", nil, "", editorA); res.status != 404 {
		t.Fatalf("another organization revoked the grant: %d", res.status)
	}
	// Authority is still the creator's live grant: demote the creator, lose the tool.
	if _, err := testPool(t).Exec(t.Context(), `UPDATE org_members SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, other, editorB["x-user-id"]); err != nil {
		t.Fatal(err)
	}
	demoted, err := (agentclient.Resolver{Pool: testPool(t)}).Resolve(t.Context(), access)
	if err != nil || demoted.Permissions["runs.start"] {
		t.Fatalf("a demoted creator's grant kept its authority: %+v %v", demoted, err)
	}
	// Revocation applies to the next call and to refresh.
	if _, err := testPool(t).Exec(t.Context(), `UPDATE agent_clients SET revoked_at = now(), revoked_by = 'x' WHERE id = $1`, principal.ClientID); err != nil {
		t.Fatal(err)
	}
	if _, err := (agentclient.Resolver{Pool: testPool(t)}).Resolve(t.Context(), access); err == nil {
		t.Fatal("a revoked grant still resolves")
	}
	refresh, _ := tokens.body["refresh_token"].(string)
	if res := h.tokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {clientID}}); res.status != 400 {
		t.Fatalf("a revoked grant refreshed: %d %s", res.status, res.text)
	}
}

func TestOAuthIsNotMountedWithoutAnIssuer(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	res, err := http.Post(h.server.URL+"/oauth/register", "application/json", strings.NewReader(`{"redirect_uris":["https://x.example/cb"]}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode == http.StatusCreated {
		t.Fatal("OAuth registration answered without an issuer")
	}
}

// Registration is unauthenticated, so it is bounded per address and in total,
// and a registration nobody used is swept.
func TestOAuthRegistrationIsBounded(t *testing.T) {
	h := newOAuthHarness(t)
	pool := testPool(t)
	body := `{"client_name":"x","redirect_uris":["https://x.example.test/cb"]}`
	limited := false
	for range 12 {
		if res := h.raw(t, "POST", "/oauth/register", "application/json", body); res.status == http.StatusTooManyRequests {
			limited = res.header.Get("Retry-After") != ""
			break
		}
	}
	if !limited {
		t.Fatal("registration from one address was never limited")
	}
	// At the global cap a new registration evicts the oldest unused one.
	if _, err := pool.Exec(t.Context(), `DELETE FROM rate_limit_windows WHERE name LIKE 'oauth.%'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `DELETE FROM oauth_clients WHERE last_used_at IS NULL;
		INSERT INTO oauth_clients (id, client_name, redirect_uris, registered_from, created_at)
		SELECT 'oc_fill_' || n, 'fill', '{https://x.example.test/cb}', '::1', now() - make_interval(secs => 2000 - n) FROM generate_series(1, 1000) n`); err != nil {
		t.Fatal(err)
	}
	fresh := h.register(t, "fresh", "https://x.example.test/cb")
	var oldest, total int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FILTER (WHERE id = 'oc_fill_1'), count(*) FROM oauth_clients WHERE last_used_at IS NULL`).Scan(&oldest, &total); err != nil {
		t.Fatal(err)
	}
	if oldest != 0 || total != 1000 || fresh == "" {
		t.Fatalf("eviction at the cap: oldest kept %d, total %d", oldest, total)
	}
	// A request waiting for consent does not pin a registration: with every
	// unused one holding a request, the oldest still makes room.
	if _, err := pool.Exec(t.Context(), `DELETE FROM rate_limit_windows WHERE name LIKE 'oauth.%'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_clients SET created_at = now() - interval '1 hour' WHERE id = $1`, fresh); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO oauth_authorization_requests (id, oauth_client_id, redirect_uri, code_challenge, scopes, state, resource, expires_at)
		SELECT gen_random_uuid()::text, id, 'https://x.example.test/cb', repeat('a', 43), '{read}', 's', 'r', now() + interval '10 minutes'
		FROM oauth_clients WHERE last_used_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	pinned := h.register(t, "pinned", "https://x.example.test/cb")
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM oauth_clients WHERE last_used_at IS NULL`).Scan(&total); err != nil || total != 1000 || pinned == "" {
		t.Fatalf("pending requests pinned the table: %d %v", total, err)
	}
	fresh = pinned
	// Registrations still in their first minutes are a flow in progress: none is evicted.
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_clients SET created_at = now() WHERE last_used_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	if res := h.raw(t, "POST", "/oauth/register", "application/json", body); res.status != http.StatusServiceUnavailable {
		t.Fatalf("registration at the cap with nothing evictable: %d %s", res.status, res.text)
	}
	var kept int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM oauth_clients WHERE id = $1`, fresh).Scan(&kept); err != nil || kept != 1 {
		t.Fatalf("a fresh registration was evicted: %d %v", kept, err)
	}
	used := h.register2(t, pool)
	if _, err := pool.Exec(t.Context(), `UPDATE oauth_clients SET created_at = now() - interval '25 hours'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < now() - interval '24 hours'`); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM oauth_clients WHERE id = $1`, used).Scan(&kept); err != nil || kept != 1 {
		t.Fatalf("a used registration was swept: %d %v", kept, err)
	}
	var unused int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM oauth_clients WHERE last_used_at IS NULL`).Scan(&unused); err != nil || unused != 0 {
		t.Fatalf("unused registrations survived the sweep: %d %v", unused, err)
	}
}

// register2 stores a registration marked as used, bypassing the address limit.
func (h oauthHarness) register2(t *testing.T, pool interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}) string {
	t.Helper()
	id := "oc_" + uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO oauth_clients (id, client_name, redirect_uris, registered_from, last_used_at)
		VALUES ($1, 'used', '{https://x.example.test/cb}', '127.0.0.1', now())`, id); err != nil {
		t.Fatal(err)
	}
	return id
}
