//go:build integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// An MCP client discovers the authorization server from the 401, registers,
// gets a person's consent and calls a tool with the access token, all against
// the production executable.
func TestExecutableConnectsRemoteMCPWithOAuth(t *testing.T) {
	baseDSN := os.Getenv("JANUSLY_DATABASE_URL")
	if baseDSN == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 120*time.Second)
	defer cancel()
	dsn, pool := runtimeTestDatabase(t, ctx, baseDSN)
	org, person := "oauth-exe-"+uuid.NewString()[:8], "person-"+uuid.NewString()[:8]
	if _, err := pool.Exec(ctx, `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor')`,
		uuid.NewString(), org, person); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "janusly")
	if out, err := exec.CommandContext(ctx, "go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v\n%s", err, out)
	}
	port, internalPort := runtimeTestPorts(t)
	base := "http://127.0.0.1:" + port
	logs := &lockedBuffer{}
	server := exec.Command(binary)
	server.Env = []string{
		"PATH=" + os.Getenv("PATH"), "JANUSLY_ENV=test", "OTEL_EXPORTER=none", "JANUSLY_HTTP_HOST=127.0.0.1",
		"JANUSLY_DATABASE_URL=" + dsn, "JANUSLY_PORT=" + port, "JANUSLY_INTERNAL_PORT=" + internalPort,
		"JANUSLY_WORKER_CONCURRENCY=1", "JANUSLY_POLL_MS=50", "JANUSLY_MCP_HTTP_ENABLED=true", "JANUSLY_WEB_BASE_URL=" + base,
	}
	server.Stdout, server.Stderr = logs, logs
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Wait() }()
	var secrets []string
	defer func() {
		_ = server.Process.Kill()
		<-done
		for _, secret := range secrets {
			if secret != "" && strings.Contains(logs.String(), secret) {
				t.Error("a code or token reached the server logs")
			}
		}
		if t.Failed() {
			t.Logf("runtime log:\n%s", logs.String())
		}
	}()
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	runtimeWait(t, ctx, func() bool {
		res, err := client.Get(base + "/healthz")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return res.StatusCode == http.StatusOK
	})
	type answer struct {
		StatusCode int
		Header     http.Header
	}
	do := func(method, target, contentType, body string, headers map[string]string) (answer, map[string]any) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, target, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		raw, _ := io.ReadAll(res.Body)
		var parsed map[string]any
		_ = json.Unmarshal(raw, &parsed)
		return answer{StatusCode: res.StatusCode, Header: res.Header}, parsed
	}

	// 1. The 401 names the resource metadata; the metadata names the server.
	unauthorized, _ := do("POST", base+"/mcp", "application/json", `{}`, nil)
	challenge := unauthorized.Header.Get("WWW-Authenticate")
	metadataURL := base + "/.well-known/oauth-protected-resource/mcp"
	if unauthorized.StatusCode != http.StatusUnauthorized || !strings.Contains(challenge, `resource_metadata="`+metadataURL+`"`) {
		t.Fatalf("challenge: %d %q", unauthorized.StatusCode, challenge)
	}
	_, resource := do("GET", metadataURL, "", "", nil)
	issuer := resource["authorization_servers"].([]any)[0].(string)
	_, meta := do("GET", issuer+"/.well-known/oauth-authorization-server", "", "", nil)

	// 2. Register, authorize, consent as the person, exchange.
	redirect := "http://127.0.0.1:1/callback"
	_, registered := do("POST", meta["registration_endpoint"].(string), "application/json",
		`{"client_name":"exe client","redirect_uris":["`+redirect+`"]}`, nil)
	clientID := registered["client_id"].(string)
	verifier := strings.ReplaceAll(uuid.NewString()+uuid.NewString(), "-", "")
	sum := sha256.Sum256([]byte(verifier))
	authorize := meta["authorization_endpoint"].(string) + "?" + url.Values{
		"client_id": {clientID}, "redirect_uri": {redirect}, "response_type": {"code"}, "state": {"s"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"scope": {"janusly:read"}, "resource": {resource["resource"].(string)},
	}.Encode()
	toConsent, _ := do("GET", authorize, "", "", nil)
	location, _ := url.Parse(toConsent.Header.Get("Location"))
	requestID := location.Query().Get("oauth_request")
	if toConsent.StatusCode != http.StatusFound || requestID == "" {
		t.Fatalf("authorize: %d %q", toConsent.StatusCode, toConsent.Header.Get("Location"))
	}
	asPerson := map[string]string{"x-org-id": org, "x-user-id": person}
	_, decided := do("POST", base+"/oauth/requests/"+requestID+"/decision", "application/json", `{"approve":true,"capabilities":["read"]}`, asPerson)
	back, _ := url.Parse(decided["redirectTo"].(string))
	code := back.Query().Get("code")
	_, tokens := do("POST", meta["token_endpoint"].(string), "application/x-www-form-urlencoded", url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier},
		"client_id": {clientID}, "redirect_uri": {redirect},
	}.Encode(), nil)
	access, _ := tokens["access_token"].(string)
	refresh, _ := tokens["refresh_token"].(string)
	secrets = []string{code, access, refresh}
	if access == "" {
		t.Fatalf("token: %v", tokens)
	}

	// 3. The access token works on /mcp like any agent token.
	mcpClient := mcp.NewClient(&mcp.Implementation{Name: "oauth-exe", Version: "1"}, nil)
	session, err := mcpClient.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: base + "/mcp", HTTPClient: &http.Client{Transport: agentBearer{token: access}},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = session.Close() }()
	info, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "agent.info", Arguments: map[string]any{}})
	if err != nil || info.IsError || !strings.Contains(info.Content[0].(*mcp.TextContent).Text, org) {
		t.Fatalf("agent.info with an OAuth token: %v %+v", err, info)
	}
}
