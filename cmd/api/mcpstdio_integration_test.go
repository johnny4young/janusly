//go:build integration

package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// A strict stdio client parses every stdout line as JSON-RPC, so a single log
// line on stdout breaks the session. Drive the real executable with the
// official SDK client to keep that boundary honest.
func TestMCPExecutableServesStrictStdioClient(t *testing.T) {
	baseDSN := os.Getenv("JANUSLY_DATABASE_URL")
	if baseDSN == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	dsn, _ := runtimeTestDatabase(t, ctx, baseDSN)
	binary := filepath.Join(t.TempDir(), "janusly-mcp")
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, "../mcp")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v\n%s", err, out)
	}

	child := exec.Command(binary)
	child.Env = []string{
		"PATH=" + os.Getenv("PATH"), "JANUSLY_ENV=test", "OTEL_EXPORTER=none",
		"JANUSLY_DATABASE_URL=" + dsn, "JANUSLY_ORG=stdio-smoke", "JANUSLY_LOG_LEVEL=debug",
		"JANUSLY_WORKER_CONCURRENCY=1", "JANUSLY_POLL_MS=50",
	}
	stderr := &lockedBuffer{}
	child.Stderr = stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "stdio-smoke", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: child, TerminateDuration: 10 * time.Second}, nil)
	if err != nil {
		t.Fatalf("connect over stdio: %v\nstderr:\n%s", err, stderr.String())
	}
	tools, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("list tools: %v\nstderr:\n%s", err, stderr.String())
	}
	if len(tools.Tools) == 0 {
		t.Fatal("stdio server listed no tools")
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "workflows.list", Arguments: map[string]any{}})
	if err != nil {
		t.Fatalf("call workflows.list: %v\nstderr:\n%s", err, stderr.String())
	}
	if result.IsError {
		t.Fatalf("workflows.list failed: %+v", result.Content)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("close session: %v\nstderr:\n%s", err, stderr.String())
	}
	if !strings.Contains(stderr.String(), `"msg":"mcp server ready"`) {
		t.Fatalf("structured logs did not reach stderr:\n%s", stderr.String())
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
