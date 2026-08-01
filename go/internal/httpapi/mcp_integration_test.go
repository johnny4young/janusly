//go:build integration

package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The MCP admin loop: fail-closed stdio creation, http create+discovery
// (untransacted triplet), and the per-tool flags route — how an admin
// marks a discovered write-side tool read-only.
func TestMcpAdminRoutes(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")

	// 1. stdio without an allowlisted command → fail-closed 400.
	res := h.call("POST", "/mcp/connections", map[string]any{
		"alias": "cli", "transport": "stdio", "command": "/bin/evil",
	}, "")
	if res.status != 400 || res.body["code"] != "mcp_command_not_allowlisted" {
		t.Fatalf("stdio fail-closed: %d %+v", res.status, res.body)
	}

	// 2. http create runs discovery against a real fixture server.
	server := mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "0.0.1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "notas.crear", Description: "creates a note"},
		func(ctx context.Context, req *mcp.CallToolRequest, args struct{}) (*mcp.CallToolResult, any, error) {
			return &mcp.CallToolResult{}, nil, nil
		})
	fixture := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	// goleak (T-511): the client's session.Close leaves the SDK server's
	// per-session jsonrpc2 readers alive — drain them explicitly.
	t.Cleanup(func() {
		for session := range server.Sessions() {
			_ = session.Close()
		}
	})
	defer fixture.Close()

	res = h.call("POST", "/mcp/connections", map[string]any{
		"alias": "notas", "transport": "http", "url": fixture.URL,
	}, "")
	if res.status != 201 {
		t.Fatalf("create: %d %+v", res.status, res.body)
	}
	connection := res.body["connection"].(map[string]any)
	if connection["status"] != "active" || connection["discovery"].(map[string]any)["tools"] != float64(1) {
		t.Fatalf("discovery on create: %+v", connection)
	}
	if res = h.call("POST", "/mcp/connections", map[string]any{
		"alias": "notas", "transport": "http", "url": fixture.URL,
	}, ""); res.status != 409 {
		t.Fatalf("duplicate alias must 409: %d", res.status)
	}

	// 3. Discovered tool is disabled + write-side; the flags route marks
	// it read-only + enabled (the admin decision) with change audits.
	res = h.call("POST", "/mcp/connections/notas/tools/notas.crear", map[string]any{
		"enabled": true, "writeSide": false, "rateLimitPerMin": 5,
	}, "")
	if res.status != 200 {
		t.Fatalf("flags: %d %+v", res.status, res.body)
	}
	tool := res.body["tool"].(map[string]any)
	if tool["enabled"] != true || tool["writeSide"] != false || tool["rateLimitPerMin"] != float64(5) {
		t.Fatalf("flags result: %+v", tool)
	}
	// Three-state: explicit null clears the override.
	res = h.call("POST", "/mcp/connections/notas/tools/notas.crear", map[string]any{
		"rateLimitPerMin": nil,
	}, "")
	if res.status != 200 || res.body["tool"].(map[string]any)["rateLimitPerMin"] != nil {
		t.Fatalf("null must clear override: %d %+v", res.status, res.body)
	}
	// Bounds + empty body.
	if res = h.call("POST", "/mcp/connections/notas/tools/notas.crear", map[string]any{
		"rateLimitPerMin": 99_999,
	}, ""); res.status != 400 {
		t.Fatalf("rate bounds: %d", res.status)
	}
	if res = h.call("POST", "/mcp/connections/notas/tools/notas.crear", map[string]any{}, ""); res.status != 400 {
		t.Fatalf("no fields must 400: %d", res.status)
	}

	// 4. Change-only audits landed.
	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action IN ('mcp.connection.created','mcp.tool.enabled','mcp.tool.rate_limit_set')`,
		h.org).Scan(&audits); err != nil || audits < 3 {
		t.Fatalf("audits: %d %v", audits, err)
	}
}
