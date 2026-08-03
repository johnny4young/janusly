//go:build integration

package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
)

// An SDK client drives the failure→redrive cycle through the in-process
// server — the same loop an agent would run from Claude.

func newMCPSession(t *testing.T) (*mcp.ClientSession, string) {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	eng := engine.New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, dispatcher.Execute,
			slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { stopWorkers(); <-done })

	org := fmt.Sprintf("mcp-org-%d", time.Now().UnixNano())
	// Write tools run under the two-flag consent; the harness models a
	// fully consented environment. The denial ladder has its own test.
	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "true")
	if _, err := pool.Exec(ctx,
		`INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		 VALUES ($1, $2, 'mcp.writeConsent', 'true', 'mcp', 'test consent', 'boolean')`,
		org+"-consent", org); err != nil {
		t.Fatalf("seed consent: %v", err)
	}
	server := NewServer(Deps{Engine: eng, Pool: pool, OrgID: org, UserID: "mcp-test", NewID: uuid.NewString})

	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		_ = server.Run(context.Background(), serverTransport)
	}()

	client := mcp.NewClient(&mcp.Implementation{Name: "parity-client", Version: "0.0.1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close(); <-serverDone })
	return session, org
}

func callTool(t *testing.T, session *mcp.ClientSession, name string, args map[string]any) (*mcp.CallToolResult, map[string]any) {
	t.Helper()
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: transport error %v", name, err)
	}
	var parsed map[string]any
	if len(res.Content) > 0 {
		if text, ok := res.Content[0].(*mcp.TextContent); ok {
			_ = json.Unmarshal([]byte(text.Text), &parsed)
		}
	}
	return res, parsed
}

func TestAgentDrivesFailureRedriveCycleOverMCP(t *testing.T) {
	session, _ := newMCPSession(t)

	tools, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		names[tool.Name] = true
	}
	for _, want := range []string{"workflows.save", "runs.start", "runs.status", "runs.inspect", "runs.list", "workflows.list", "dlq.list", "dlq.redrive"} {
		if !names[want] {
			t.Fatalf("tool %s missing; got %v", want, names)
		}
	}

	var healed bool
	var mu sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ok := healed
		mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"restored":true}`))
	}))
	defer upstream.Close()

	workflow := map[string]any{
		"id":   "mcp-wedge-" + fmt.Sprint(time.Now().UnixNano()),
		"name": "MCP wedge",
		"nodes": []any{
			map[string]any{"id": "call", "type": "http", "config": map[string]any{
				"url":   upstream.URL,
				"retry": map[string]any{"maxAttempts": 2, "delayMs": 50},
			}},
		},
		"edges": []any{},
	}

	saveRes, saved := callTool(t, session, "workflows.save", map[string]any{"workflow": workflow})
	if saveRes.IsError {
		t.Fatalf("save error: %s", saveRes.Content[0].(*mcp.TextContent).Text)
	}
	if saved["version"] != float64(1) {
		t.Fatalf("save: %v", saved)
	}

	_, started := callTool(t, session, "runs.start", map[string]any{"workflow": workflow})
	runID, _ := started["runId"].(string)
	if runID == "" {
		t.Fatalf("start: %v", started)
	}

	waitStatus := func(want string) map[string]any {
		deadline := time.Now().Add(20 * time.Second)
		for {
			_, status := callTool(t, session, "runs.status", map[string]any{"runId": runID})
			if status["status"] == want {
				return status
			}
			if time.Now().After(deadline) {
				t.Fatalf("run stuck: %v, want %s", status["status"], want)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	waitStatus("failed")

	_, dlq := callTool(t, session, "dlq.list", map[string]any{"limit": 50})
	var deadLetterID string
	for _, raw := range dlq["deadLetters"].([]any) {
		row := raw.(map[string]any)
		if row["runId"] == runID {
			deadLetterID = row["id"].(string)
		}
	}
	if deadLetterID == "" {
		t.Fatalf("dead letter expected: %v", dlq)
	}

	mu.Lock()
	healed = true
	mu.Unlock()
	redriveRes, redriven := callTool(t, session, "dlq.redrive", map[string]any{"deadLetterId": deadLetterID})
	if redriveRes.IsError || redriven["redriven"] != true {
		t.Fatalf("redrive: %v %v", redriveRes.IsError, redriven)
	}
	waitStatus("succeeded")

	// Expected-failure posture: a second redrive is an isError result with a
	// readable message, never a transport error.
	conflict, _ := callTool(t, session, "dlq.redrive", map[string]any{"deadLetterId": deadLetterID})
	if !conflict.IsError {
		t.Fatal("double redrive must be an isError tool result")
	}
	text := conflict.Content[0].(*mcp.TextContent).Text
	if !strings.Contains(text, "already claimed") {
		t.Fatalf("conflict message: %s", text)
	}

	// Inspect returns the timeline an operator would read.
	_, inspected := callTool(t, session, "runs.inspect", map[string]any{"runId": runID})
	if inspected["status"] != "succeeded" {
		t.Fatalf("inspect: %v", inspected["status"])
	}
	events, _ := inspected["recentEvents"].([]any)
	sawRedriven := false
	for _, raw := range events {
		if raw.(map[string]any)["type"] == "node.redriven" {
			sawRedriven = true
		}
	}
	if !sawRedriven {
		t.Fatal("timeline must carry node.redriven")
	}

	// Unknown run: expected failure, structured.
	ghost, _ := callTool(t, session, "runs.status", map[string]any{"runId": "ghost"})
	if !ghost.IsError {
		t.Fatal("unknown run must be an isError result")
	}
}

// The inspect list tools paginate by keyset: page one carries nextCursor,
// page two picks up exactly where it left off, filters narrow runs.
func TestMcpListToolsPaginate(t *testing.T) {
	session, _ := newMCPSession(t)

	for i := range 3 {
		doc := map[string]any{
			"id":    fmt.Sprintf("mcp-page-%d-%d", i, time.Now().UnixNano()),
			"name":  fmt.Sprintf("paged %d", i),
			"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
			"edges": []any{},
		}
		if res, _ := callTool(t, session, "workflows.save", map[string]any{"workflow": doc}); res.IsError {
			t.Fatalf("save %d failed", i)
		}
		if res, _ := callTool(t, session, "runs.start", map[string]any{"workflow": doc}); res.IsError {
			t.Fatalf("start %d failed", i)
		}
	}

	_, page1 := callTool(t, session, "workflows.list", map[string]any{"limit": 2})
	rows1 := page1["workflows"].([]any)
	if len(rows1) != 2 || page1["hasMore"] != true || page1["nextCursor"] == nil {
		t.Fatalf("page1: %+v", page1)
	}
	_, page2 := callTool(t, session, "workflows.list", map[string]any{
		"limit": 2, "cursor": page1["nextCursor"].(string),
	})
	rows2 := page2["workflows"].([]any)
	if len(rows2) != 1 || page2["hasMore"] != false {
		t.Fatalf("page2: %+v", page2)
	}
	if rows1[0].(map[string]any)["workflowId"] == rows2[0].(map[string]any)["workflowId"] {
		t.Fatal("pages must not overlap")
	}

	_, runsPage := callTool(t, session, "runs.list", map[string]any{"limit": 2})
	if len(runsPage["runs"].([]any)) != 2 || runsPage["hasMore"] != true {
		t.Fatalf("runs page: %+v", runsPage)
	}
	wfID := rows2[0].(map[string]any)["workflowId"].(string)
	_, filtered := callTool(t, session, "runs.list", map[string]any{"workflowId": wfID})
	if len(filtered["runs"].([]any)) != 1 || filtered["hasMore"] != false {
		t.Fatalf("filtered runs: %+v", filtered)
	}
}

// The write-consent denial ladder: process flag off → verbatim process
// message; flag on without tenant consent → verbatim tenant message.
// Read tools stay available throughout.
func TestMcpWriteConsentLadder(t *testing.T) {
	session, orgID := newMCPSession(t)
	doc := map[string]any{
		"id":    fmt.Sprintf("mcp-consent-%d", time.Now().UnixNano()),
		"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}

	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "")
	res, _ := callTool(t, session, "workflows.save", map[string]any{"workflow": doc})
	if !res.IsError {
		t.Fatal("process-level denial expected")
	}
	text := res.Content[0].(*mcp.TextContent).Text
	if text != "MCP writes are disabled at the process level (JANUSLY_MCP_WRITES_ENABLED is not 'true')." {
		t.Fatalf("process message drifted: %q", text)
	}

	// Read tools are never gated.
	if res, _ := callTool(t, session, "workflows.list", map[string]any{}); res.IsError {
		t.Fatal("reads must not be gated")
	}

	// Flag on, tenant consent revoked → the tenant message.
	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "true")
	pool := poolForTest(t)
	if _, err := pool.Exec(context.Background(),
		`UPDATE org_configs SET value_json = 'false' WHERE org_id = $1 AND key = 'mcp.writeConsent'`,
		orgID); err != nil {
		t.Fatalf("revoke consent: %v", err)
	}
	res, _ = callTool(t, session, "runs.start", map[string]any{"workflow": doc})
	if !res.IsError {
		t.Fatal("tenant-level denial expected")
	}
	text = res.Content[0].(*mcp.TextContent).Text
	if text != "MCP writes are not consented for this organization (mcp.writeConsent is false)." {
		t.Fatalf("tenant message drifted: %q", text)
	}
}

func poolForTest(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("JANUSLY_DATABASE_URL"))
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}
