//go:build integration

package main

import (
	"context"
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

// The stdio executable acts as the agent client its token names: its
// organization, its tools only, and revocation on the next call.
func TestMCPExecutableActsAsTheAgentClient(t *testing.T) {
	baseDSN := os.Getenv("JANUSLY_DATABASE_URL")
	if baseDSN == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	dsn, pool := runtimeTestDatabase(t, ctx, baseDSN)
	org, creator := "agent-exe-"+uuid.NewString()[:8], "creator-"+uuid.NewString()[:8]
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
		OrgID: org, CreatedBy: creator, Name: "exe agent",
	}, held)
	if err != nil {
		t.Fatal(err)
	}

	binary := filepath.Join(t.TempDir(), "janusly-mcp")
	if out, err := exec.CommandContext(ctx, "go", "build", "-o", binary, "../mcp").CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v\n%s", err, out)
	}
	child := exec.Command(binary)
	child.Env = []string{
		"PATH=" + os.Getenv("PATH"), "JANUSLY_ENV=test", "OTEL_EXPORTER=none",
		"JANUSLY_DATABASE_URL=" + dsn, "JANUSLY_ORG=ignored-org", "JANUSLY_AGENT_TOKEN=" + issued.Token,
		"JANUSLY_WORKER_CONCURRENCY=1", "JANUSLY_POLL_MS=50",
	}
	stderr := &lockedBuffer{}
	child.Stderr = stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "agent-exe", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: child, TerminateDuration: 10 * time.Second}, nil)
	if err != nil {
		t.Fatalf("connect: %v\nstderr:\n%s", err, stderr.String())
	}
	defer func() { _ = session.Close() }()

	tools, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("list tools: %v\nstderr:\n%s", err, stderr.String())
	}
	for _, tool := range tools.Tools {
		if tool.Name == "runs.start" || tool.Name == "workflows.save" {
			t.Fatalf("read-only client lists %s", tool.Name)
		}
	}
	info, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "agent.info", Arguments: map[string]any{}})
	if err != nil || info.IsError {
		t.Fatalf("agent.info: %v %+v\nstderr:\n%s", err, info, stderr.String())
	}
	if text := info.Content[0].(*mcp.TextContent).Text; !strings.Contains(text, org) || strings.Contains(text, "ignored-org") {
		t.Fatalf("executable acted outside the token's organization: %s", text)
	}
	if strings.Contains(stderr.String(), issued.Token) {
		t.Fatal("the token reached the logs")
	}

	if _, err := q.RevokeAgentClient(ctx, store.RevokeAgentClientParams{OrgID: org, ID: issued.Client.ID, RevokedBy: creator}); err != nil {
		t.Fatal(err)
	}
	after, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "agent.info", Arguments: map[string]any{}})
	if err != nil || !after.IsError || after.Content[0].(*mcp.TextContent).Text != "agent token is invalid, expired or revoked" {
		t.Fatalf("revocation did not apply on the next call: %v %+v", err, after)
	}
}
