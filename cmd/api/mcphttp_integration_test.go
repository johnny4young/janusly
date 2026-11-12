//go:build integration

package main

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/store"
)

type agentBearer struct{ token string }

func (b agentBearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

// The production executable serves remote MCP on its public port only when
// enabled, and only to agent tokens.
func TestExecutableServesRemoteMCPWhenEnabled(t *testing.T) {
	baseDSN := os.Getenv("JANUSLY_DATABASE_URL")
	if baseDSN == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 120*time.Second)
	defer cancel()
	dsn, pool := runtimeTestDatabase(t, ctx, baseDSN)
	org, creator := "remote-exe-"+uuid.NewString()[:8], "creator-"+uuid.NewString()[:8]
	if _, err := pool.Exec(ctx, `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor')`,
		uuid.NewString(), org, creator); err != nil {
		t.Fatal(err)
	}
	q := store.New(pool)
	held, err := agentclient.CreatorPermissions(ctx, q, org, creator)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := agentclient.Issue(ctx, q, uuid.NewString(), time.Now(), agentclient.IssueInput{
		OrgID: org, CreatedBy: creator, Name: "remote exe agent",
	}, held)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "janusly")
	if out, err := exec.CommandContext(ctx, "go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v\n%s", err, out)
	}

	start := func(enabled bool) (string, func()) {
		port, internalPort := runtimeTestPorts(t)
		logs := &lockedBuffer{}
		child := exec.Command(binary)
		child.Env = []string{
			"PATH=" + os.Getenv("PATH"), "JANUSLY_ENV=test", "OTEL_EXPORTER=none", "JANUSLY_HTTP_HOST=127.0.0.1",
			"JANUSLY_DATABASE_URL=" + dsn, "JANUSLY_PORT=" + port, "JANUSLY_INTERNAL_PORT=" + internalPort,
			"JANUSLY_WORKER_CONCURRENCY=1", "JANUSLY_POLL_MS=50",
		}
		if enabled {
			child.Env = append(child.Env, "JANUSLY_MCP_HTTP_ENABLED=true")
		}
		child.Stdout, child.Stderr = logs, logs
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- child.Wait() }()
		base := "http://127.0.0.1:" + port
		probe := &http.Client{Timeout: 200 * time.Millisecond}
		t.Cleanup(func() {
			if t.Failed() {
				t.Logf("runtime log:\n%s", logs.String())
			}
		})
		runtimeWait(t, ctx, func() bool {
			res, err := probe.Get(base + "/healthz")
			if err != nil {
				return false
			}
			_ = res.Body.Close()
			return res.StatusCode == http.StatusOK
		})
		return base, func() {
			_ = child.Process.Kill()
			<-done
			if strings.Contains(logs.String(), issued.Token) {
				t.Error("the token reached the logs")
			}
		}
	}

	disabled, stop := start(false)
	res, err := http.Post(disabled+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode == http.StatusOK || res.StatusCode == http.StatusUnauthorized {
		t.Fatalf("remote MCP answered while disabled: %d", res.StatusCode)
	}
	stop()

	base, stop := start(true)
	defer stop()
	client := mcp.NewClient(&mcp.Implementation{Name: "remote-exe", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: base + "/mcp", HTTPClient: &http.Client{Transport: agentBearer{token: issued.Token}},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = session.Close() }()
	info, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "agent.info", Arguments: map[string]any{}})
	if err != nil || info.IsError || !strings.Contains(info.Content[0].(*mcp.TextContent).Text, org) {
		t.Fatalf("agent.info over HTTP: %v %+v", err, info)
	}
	anonymous, err := http.Post(base+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = anonymous.Body.Close()
	if anonymous.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous request: %d", anonymous.StatusCode)
	}
}
