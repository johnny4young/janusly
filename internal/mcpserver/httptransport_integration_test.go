//go:build integration

package mcpserver

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/store"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type bearerTransport struct {
	token string
	base  http.RoundTripper
}

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.base.RoundTrip(r)
}

func remoteSession(t *testing.T, endpoint, token string) (*mcp.ClientSession, error) {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "remote-agent", Version: "1"}, nil)
	return client.Connect(t.Context(), &mcp.StreamableClientTransport{
		Endpoint:   endpoint,
		HTTPClient: &http.Client{Transport: bearerTransport{token: token, base: http.DefaultTransport}},
	}, nil)
}

func rawPost(t *testing.T, endpoint string, headers map[string]string, body string) (int, string, http.Header) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for name, value := range headers {
		if name == "Host" {
			req.Host = value
			continue
		}
		req.Header.Set(name, value)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(raw), res.Header
}

const initializeBody = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"raw","version":"1"}}}`

func TestRemoteMCPServesAgentClientsOverStreamableHTTP(t *testing.T) {
	pool, eng := agentTestPool(t)
	tenant := seedAgentTenant(t, pool, eng, "remote")
	issued := issueAgentClient(t, pool, tenant, agentclient.IssueInput{Capabilities: []string{"operate"}})
	logs := &syncBuffer{}
	server := httptest.NewServer(NewHTTPHandler(Deps{Engine: eng, Pool: pool, NewID: uuid.NewString},
		HTTPOptions{AllowedHosts: []string{"janusly.example.com"}, Logger: slog.New(slog.NewTextHandler(logs, nil))}))
	t.Cleanup(server.Close)
	endpoint := server.URL + "/mcp"

	session, err := remoteSession(t, endpoint, issued.Token)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	tools, err := session.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == "workflows.save" {
			t.Fatal("remote client lists workflows.save")
		}
	}
	res, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "runs.start", Arguments: map[string]any{"workflowId": tenant.workflowID}})
	if err != nil || res.IsError {
		t.Fatalf("remote runs.start: %v %q", err, resultText(res))
	}
	var transport string
	if err := pool.QueryRow(t.Context(), `SELECT metadata->>'transport' FROM audit_logs
		WHERE org_id = $1 AND user_id = $2 AND action = 'mcp.tool.invoked' AND target_id = 'runs.start'`,
		tenant.org, "agent:"+issued.Client.ID).Scan(&transport); err != nil || transport != "http" {
		t.Fatalf("remote call audit transport: %q %v", transport, err)
	}

	unissued, _, _, err := agentclient.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	// Every credential failure reads the same, with the bearer challenge.
	for label, headers := range map[string]map[string]string{
		"missing":       {},
		"malformed":     {"Authorization": "Bearer jly_agent_short"},
		"unknown":       {"Authorization": "Bearer " + strings.Repeat("A", 10)},
		"unissued":      {"Authorization": "Bearer " + unissued},
		"service token": {"Authorization": "Bearer svc", "x-org-id": tenant.org, "x-user-id": tenant.creator},
		"dev headers":   {"x-org-id": tenant.org, "x-user-id": tenant.creator},
	} {
		status, _, header := rawPost(t, endpoint, headers, initializeBody)
		if status != http.StatusUnauthorized || !strings.HasPrefix(header.Get("WWW-Authenticate"), "Bearer") {
			t.Fatalf("%s credential: status %d challenge %q", label, status, header.Get("WWW-Authenticate"))
		}
	}

	auth := map[string]string{"Authorization": "Bearer " + issued.Token}
	if status, body, _ := rawPost(t, endpoint+"?access_token="+issued.Token, auth, initializeBody); status != http.StatusBadRequest || strings.Contains(body, issued.Token) {
		t.Fatalf("token in the URL: %d %q", status, body)
	}
	if strings.Contains(logs.String(), issued.Token) {
		t.Fatal("the token reached the logs")
	}
	withHost := map[string]string{"Authorization": "Bearer " + issued.Token, "Host": "attacker.example"}
	if status, _, _ := rawPost(t, endpoint, withHost, initializeBody); status != http.StatusForbidden {
		t.Fatalf("rebinding host accepted: %d", status)
	}
	allowedHost := map[string]string{"Authorization": "Bearer " + issued.Token, "Host": "janusly.example.com"}
	if status, _, _ := rawPost(t, endpoint, allowedHost, initializeBody); status != http.StatusOK {
		t.Fatalf("configured host refused: %d", status)
	}
	withOrigin := map[string]string{"Authorization": "Bearer " + issued.Token, "Origin": "https://attacker.example"}
	if status, _, _ := rawPost(t, endpoint, withOrigin, initializeBody); status != http.StatusForbidden {
		t.Fatalf("browser origin accepted: %d", status)
	}
	batch := "[" + strings.TrimSuffix(strings.Repeat(initializeBody+",", 3), ",") + "]"
	if status, _, _ := rawPost(t, endpoint, auth, batch); status != http.StatusBadRequest {
		t.Fatalf("JSON-RPC batch accepted: %d", status)
	}
	if status, _, _ := rawPost(t, endpoint+"?session="+issued.Token, auth, initializeBody); status != http.StatusBadRequest {
		t.Fatalf("token under another query name accepted: %d", status)
	}
	big := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workflows.validate","arguments":{"workflow":{"name":"` +
		strings.Repeat("x", 300_000) + `"}}}}`
	if status, _, _ := rawPost(t, endpoint, auth, big); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: %d", status)
	}

	getReq, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, endpoint, nil)
	getReq.Header.Set("Authorization", "Bearer "+issued.Token)
	getReq.Header.Set("Accept", "text/event-stream")
	if res, err := http.DefaultClient.Do(getReq); err != nil || res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("stateless GET: %v %v", err, res)
	} else {
		_ = res.Body.Close()
	}

	strict := httptest.NewServer(NewHTTPHandler(Deps{Engine: eng, Pool: pool, NewID: uuid.NewString},
		HTTPOptions{RefuseForwardedHTTP: true}))
	t.Cleanup(strict.Close)
	forwarded := map[string]string{"Authorization": "Bearer " + issued.Token, "X-Forwarded-Proto": "http"}
	if status, _, _ := rawPost(t, strict.URL+"/mcp", forwarded, initializeBody); status != http.StatusForbidden {
		t.Fatalf("plain HTTP behind the proxy accepted: %d", status)
	}
	forwarded["X-Forwarded-Proto"] = "https"
	if status, _, _ := rawPost(t, strict.URL+"/mcp", forwarded, initializeBody); status != http.StatusOK {
		t.Fatalf("https behind the proxy refused: %d", status)
	}

	if _, err := store.New(pool).RevokeAgentClient(context.Background(), store.RevokeAgentClientParams{
		OrgID: tenant.org, ID: issued.Client.ID, RevokedBy: tenant.creator,
	}); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := rawPost(t, endpoint, auth, initializeBody); status != http.StatusUnauthorized {
		t.Fatalf("revoked token still answered: %d", status)
	}
}

func TestRemoteMCPAuditsAndLimitsRejectedTokens(t *testing.T) {
	pool, eng := agentTestPool(t)
	tenant := seedAgentTenant(t, pool, eng, "rejected")
	revoked := issueAgentClient(t, pool, tenant, agentclient.IssueInput{})
	if _, err := store.New(pool).RevokeAgentClient(t.Context(), store.RevokeAgentClientParams{
		OrgID: tenant.org, ID: revoked.Client.ID, RevokedBy: tenant.creator,
	}); err != nil {
		t.Fatal(err)
	}
	live := issueAgentClient(t, pool, tenant, agentclient.IssueInput{})
	unissued, _, _, err := agentclient.NewToken()
	if err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}
	server := httptest.NewServer(NewHTTPHandler(Deps{Engine: eng, Pool: pool, NewID: uuid.NewString},
		HTTPOptions{Logger: slog.New(slog.NewTextHandler(logs, nil))}))
	t.Cleanup(server.Close)
	endpoint := server.URL + "/mcp"
	t.Setenv("JANUSLY_TRUSTED_PROXY", "true")
	newAddress := func() string {
		id := uuid.New()
		return net.ParseIP(fmt.Sprintf("2001:db8::%x:%x:%x", id[0:2], id[2:4], id[4:6])).String()
	}
	address := newAddress()
	from := func(token string) map[string]string {
		return map[string]string{"Authorization": "Bearer " + token, "X-Forwarded-For": address}
	}
	auditedFrom := func(address string) int {
		t.Helper()
		var count int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs WHERE action = 'mcp.auth.rejected'
			AND metadata->>'clientAddress' = $1`, address).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	if status, _, _ := rawPost(t, endpoint, from(revoked.Token), initializeBody); status != http.StatusUnauthorized {
		t.Fatalf("revoked token: %d", status)
	}
	var reason, metadata string
	if err := pool.QueryRow(t.Context(), `SELECT metadata->>'reason', metadata::text FROM audit_logs
		WHERE org_id = $1 AND action = 'mcp.auth.rejected' AND target_id = $2`, tenant.org, revoked.Client.ID).Scan(&reason, &metadata); err != nil || reason != "revoked" {
		t.Fatalf("revoked token audit in its organization: %q %v", reason, err)
	}
	if status, _, _ := rawPost(t, endpoint, from(unissued), initializeBody); status != http.StatusUnauthorized {
		t.Fatalf("unknown token: %d", status)
	}
	var unknown string
	if err := pool.QueryRow(t.Context(), `SELECT metadata::text FROM audit_logs WHERE org_id = 'system'
		AND action = 'mcp.auth.rejected' AND metadata->>'clientAddress' = $1 AND metadata->>'reason' = 'unknown'`, address).Scan(&unknown); err != nil {
		t.Fatalf("unknown token audit: %v", err)
	}
	for _, text := range []string{metadata, unknown, logs.String()} {
		for _, token := range []string{revoked.Token, unissued, revoked.Token[len(agentclient.TokenPrefix):],
			fmt.Sprintf("%x", agentclient.Digest(revoked.Token)), revoked.Client.TokenLast4} {
			if strings.Contains(text, token) {
				t.Fatalf("a token reached audit or logs: %s", text)
			}
		}
	}

	status, body, header := 0, "", http.Header{}
	for range failedAuthLimit.Max {
		if status, body, header = rawPost(t, endpoint, from(unissued), initializeBody); status != http.StatusUnauthorized {
			break
		}
	}
	if status != http.StatusTooManyRequests || header.Get("Retry-After") == "" ||
		!strings.Contains(body, `"code":"rate_limited"`) || !strings.Contains(header.Get("Content-Type"), "application/json") {
		t.Fatalf("failed attempts past the limit: %d %q %v", status, body, header)
	}
	if got := auditedFrom(address); got != failedAuthLimit.Max {
		t.Fatalf("failures past the limit must not be audited: %d rows", got)
	}
	if status, _, _ := rawPost(t, endpoint, map[string]string{"Authorization": "Bearer " + live.Token}, initializeBody); status != http.StatusOK {
		t.Fatalf("a valid token was refused: %d", status)
	}
	other := newAddress()
	elsewhere := map[string]string{"Authorization": "Bearer " + unissued, "X-Forwarded-For": other}
	if status, _, _ := rawPost(t, endpoint, elsewhere, initializeBody); status != http.StatusUnauthorized {
		t.Fatalf("another address shared the exhausted bucket: %d", status)
	}
	// Probes without a bearer are neither counted nor audited.
	for range failedAuthLimit.Max + 1 {
		if status, _, header := rawPost(t, endpoint, map[string]string{"X-Forwarded-For": other}, initializeBody); status != http.StatusUnauthorized ||
			header.Get("WWW-Authenticate") == "" {
			t.Fatalf("a probe without a bearer: %d %v", status, header)
		}
	}

	// A caller that hangs up before the limiter runs is still counted.
	hungUp := newAddress()
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	handler := NewHTTPHandler(Deps{Engine: eng, Pool: pool, NewID: uuid.NewString}, HTTPOptions{})
	for range failedAuthLimit.Max + 5 {
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(initializeBody)).WithContext(cancelled)
		req.Host = "localhost"
		req.Header.Set("Authorization", "Bearer x")
		req.Header.Set("X-Forwarded-For", hungUp)
		handler.ServeHTTP(httptest.NewRecorder(), req)
	}
	if got := auditedFrom(hungUp); got != failedAuthLimit.Max {
		t.Fatalf("cancelled attempts bypassed the limiter: %d rows", got)
	}
}
