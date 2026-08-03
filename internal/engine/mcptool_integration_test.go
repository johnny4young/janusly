//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

// The mcp_tool node through a real run: a streamable-HTTP MCP server
// answers, the node persists {status, output}, the event family lands,
// and a failing envelope drives the node into the ordinary failure path.
func TestMcpToolNodeThroughRun(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()
	org := fmt.Sprintf("org-mcpnode-%d", time.Now().UnixNano())

	server := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "0.0.1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "saluda", Description: "greets"},
		func(ctx context.Context, req *mcp.CallToolRequest, args struct {
			Name string `json:"name"`
		}) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{
				&mcp.TextContent{Text: "hola " + args.Name},
			}}, nil, nil
		})
	fixture := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	// goleak: the client's session.Close leaves the SDK server's
	// per-session jsonrpc2 readers alive — drain them explicitly.
	t.Cleanup(func() {
		for session := range server.Sessions() {
			_ = session.Close()
		}
	})
	defer fixture.Close()

	connID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO mcp_connections
		(id, org_id, alias, transport, args, url, env_refs, enabled, status)
		VALUES ($1, $2, 'fixture', 'http', '[]', $3, '{}', true, 'active')`,
		connID, org, fixture.URL); err != nil {
		t.Fatalf("seed connection: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO mcp_tool_descriptors
		(id, connection_id, name, write_side, enabled)
		VALUES ($1, $2, 'saluda', false, true)`, uuid.NewString(), connID); err != nil {
		t.Fatalf("seed descriptor: %v", err)
	}

	wf := &domain.Workflow{
		ID: "wf-mcp-node", Name: "MCP", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "m", Type: "mcp_tool", Config: map[string]any{
			"connectionAlias": "fixture", "toolName": "saluda",
			"input": map[string]any{"name": "mundo"},
		}}},
		Edges: []domain.Edge{},
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	var raw []byte
	_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'm'`, runID).Scan(&raw)
	var state struct {
		Output struct {
			Status string         `json:"status"`
			Output map[string]any `json:"output"`
		} `json:"output"`
	}
	_ = json.Unmarshal(raw, &state)
	if state.Output.Status != "completed" || state.Output.Output["text"] != "hola mundo" {
		t.Fatalf("mcp_tool output: %s", raw)
	}
	var events int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1
		AND type IN ('mcp_tool.started','mcp_tool.completed')`, runID).Scan(&events)
	if events != 2 {
		t.Fatalf("event family: %d", events)
	}

	// Validation replay: the READ-ONLY tool still executes for real
	// (dry-run skips write-side only) — the admin's read-only marking is
	// what lets validation produce real signal.
	dryWf := &domain.Workflow{
		ID: "wf-mcp-dry", Name: "MCP", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "m", Type: "mcp_tool", Config: map[string]any{
			"connectionAlias": "fixture", "toolName": "saluda",
			"input": map[string]any{"name": "sombra"},
		}}},
		Edges: []domain.Edge{},
	}
	runID, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: dryWf, ReplayMode: "validation"})
	if err != nil {
		t.Fatalf("start dry: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	raw = nil
	_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'm'`, runID).Scan(&raw)
	state = struct {
		Output struct {
			Status string         `json:"status"`
			Output map[string]any `json:"output"`
		} `json:"output"`
	}{}
	_ = json.Unmarshal(raw, &state)
	if state.Output.Output["text"] != "hola sombra" || state.Output.Output["skipped"] == true {
		t.Fatalf("read-only tool must EXECUTE in validation: %s", raw)
	}

	// And a write-side descriptor SKIPS in the same validation mode.
	if _, err := pool.Exec(ctx, `UPDATE mcp_tool_descriptors SET write_side = true WHERE connection_id = $1`, connID); err != nil {
		t.Fatal(err)
	}
	runID, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: &domain.Workflow{
		ID: "wf-mcp-dry-write", Name: "MCP", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "m", Type: "mcp_tool", Config: map[string]any{
			"connectionAlias": "fixture", "toolName": "saluda",
			"input": map[string]any{"name": "x"},
		}}},
		Edges: []domain.Edge{},
	}, ReplayMode: "validation"})
	if err != nil {
		t.Fatalf("start dry write: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	raw = nil
	_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'm'`, runID).Scan(&raw)
	if !strings.Contains(string(raw), `"skipped":true`) && !strings.Contains(string(raw), `"skipped": true`) {
		t.Fatalf("write-side tool must SKIP in validation: %s", raw)
	}
	if _, err := pool.Exec(ctx, `UPDATE mcp_tool_descriptors SET write_side = false WHERE connection_id = $1`, connID); err != nil {
		t.Fatal(err)
	}

	// A missing tool fails through the ordinary node-failure path.
	bad := &domain.Workflow{
		ID: "wf-mcp-bad", Name: "MCP", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "m", Type: "mcp_tool", Config: map[string]any{
			"connectionAlias": "fixture", "toolName": "fantasma",
		}}},
		Edges: []domain.Edge{},
	}
	runID, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: bad})
	if err != nil {
		t.Fatalf("start bad: %v", err)
	}
	waitRunStatus(t, pool, runID, "failed", 0)
}
