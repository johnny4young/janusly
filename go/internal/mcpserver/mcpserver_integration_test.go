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

	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

// An SDK client drives the failure→redrive cycle through the in-process
// server — the same loop an agent would run from Claude.

func newMCPSession(t *testing.T) (*mcp.ClientSession, string) {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set; run through `make test`")
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
	for _, want := range []string{"workflows.save", "runs.start", "runs.status", "runs.inspect", "dlq.list", "dlq.redrive"} {
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
