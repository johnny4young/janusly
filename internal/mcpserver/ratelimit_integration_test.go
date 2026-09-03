//go:build integration

package mcpserver

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/ratelimit"
)

// MCP writes carry the contract's per-tool org rate limit: bucket
// `mcp.<tool>`, 60/min. A saturated window turns the write into the
// expected tool error with the limiter's verbatim message; reads and
// other tools stay unaffected.
func TestMcpWriteRateLimit(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	org := fmt.Sprintf("mcp-rl-org-%d", time.Now().UnixNano())
	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "true")
	if _, err := pool.Exec(ctx,
		`INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		 VALUES ($1, $2, 'mcp.writeConsent', 'true', 'mcp', 'test consent', 'boolean')`,
		org+"-consent", org); err != nil {
		t.Fatalf("seed consent: %v", err)
	}

	// Saturate the save bucket for this org: current + next window, so a
	// minute-boundary crossing mid-test cannot un-saturate it.
	for _, offset := range []time.Duration{0, time.Minute} {
		windowStart := time.Now().UTC().Truncate(time.Minute).Add(offset)
		expires := windowStart.Add(time.Minute)
		if _, err := pool.Exec(ctx, `INSERT INTO rate_limit_windows (name, key, window_start, count, expires_at)
			VALUES ('mcp.workflows.save', $1, $2, 60, $3)`, org, windowStart, expires); err != nil {
			t.Fatalf("saturate window: %v", err)
		}
	}

	deps := Deps{
		Engine: engine.New(pool), Pool: pool, OrgID: org, UserID: "mcp-test",
		NewID: uuid.NewString, Permissions: fullMCPTestPermissions(),
		Limiter: ratelimit.New(pool, ratelimit.Hooks{}),
	}
	server := NewServer(deps)
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	go func() { _ = server.Run(context.Background(), serverTransport) }()
	client := mcp.NewClient(&mcp.Implementation{Name: "rl-client", Version: "0.0.1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	_ = slog.New(slog.NewTextHandler(io.Discard, nil))

	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "workflows.save", Arguments: map[string]any{
		"workflow": map[string]any{
			"id": "wf-rl-" + org, "name": "RL",
			"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
			"edges": []any{},
		},
	}})
	if err != nil {
		t.Fatalf("transport: %v", err)
	}
	if !res.IsError {
		t.Fatal("saturated bucket must reject the write as an expected tool error")
	}
	text := res.Content[0].(*mcp.TextContent).Text
	if !strings.HasPrefix(text, "Rate limit exceeded for mcp.workflows.save. Retry in ") {
		t.Fatalf("limiter message must be verbatim: %q", text)
	}

	// A different tool's bucket is untouched: the redrive write passes the
	// limiter and fails later on its own not-found ladder instead.
	redrive, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "dlq.redrive", Arguments: map[string]any{
		"deadLetterId": "nope",
	}})
	if err != nil {
		t.Fatalf("transport: %v", err)
	}
	redriveText := redrive.Content[0].(*mcp.TextContent).Text
	if strings.Contains(redriveText, "Rate limit") {
		t.Fatalf("other bucket must not be limited: %q", redriveText)
	}
}

func TestMcpPermissionDenialsCannotConsumeAuthorizedToolBucket(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	org := fmt.Sprintf("mcp-denied-rl-org-%d", time.Now().UnixNano())
	user := "read-only-agent"
	t.Setenv("JANUSLY_MCP_WRITES_ENABLED", "true")
	if _, err := pool.Exec(ctx,
		`INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		 VALUES ($1, $2, 'mcp.writeConsent', 'true', 'mcp', 'test consent', 'boolean')`,
		org+"-consent", org); err != nil {
		t.Fatalf("seed consent: %v", err)
	}
	permissions := map[string]bool{"workflows.read": true}
	deps := Deps{
		Pool: pool, OrgID: org, UserID: user, Permissions: permissions,
		Limiter: ratelimit.New(pool, ratelimit.Hooks{}),
	}

	for range 60 {
		allowed, message := deps.guardTool(ctx, "workflows.save", "workflows.write", true)
		if allowed || message != "MCP actor lacks permission workflows.write." {
			t.Fatalf("permission denial drifted: allowed=%v message=%q", allowed, message)
		}
	}
	permissions["workflows.write"] = true
	allowed, message := deps.guardTool(ctx, "workflows.save", "workflows.write", true)
	if !allowed || message != "" {
		t.Fatalf("denied calls consumed authorized capacity: allowed=%v message=%q", allowed, message)
	}

	var authorizedCount, deniedCount int64
	deniedKey := fmt.Sprintf("%d:%s%s", len(org), org, user)
	if err := pool.QueryRow(ctx, `SELECT COALESCE(sum(count), 0) FROM rate_limit_windows
		WHERE name='mcp.workflows.save' AND key=$1`, org).Scan(&authorizedCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COALESCE(sum(count), 0) FROM rate_limit_windows
		WHERE name='mcp.denied.workflows.save' AND key=$1`, deniedKey).Scan(&deniedCount); err != nil {
		t.Fatal(err)
	}
	if authorizedCount != 1 || deniedCount != 60 {
		t.Fatalf("unexpected limiter isolation: authorized=%d denied=%d", authorizedCount, deniedCount)
	}
}

func TestMcpOversizedRequestIsDeniedRateLimitedAndAuditedOnce(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	org := fmt.Sprintf("mcp-bounds-org-%d", time.Now().UnixNano())
	user := "bounded-agent"
	server := NewServer(Deps{
		Pool: pool, OrgID: org, UserID: user,
		Permissions: map[string]bool{"runs.read": true},
		Limiter:     ratelimit.New(pool, ratelimit.Hooks{}),
	})
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		_ = server.Run(context.Background(), serverTransport)
	}()
	client := mcp.NewClient(&mcp.Implementation{Name: "bounds-client", Version: "1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close(); <-serverDone })

	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "runs.status",
		Arguments: map[string]any{"runId": strings.Repeat("x", maxMCPRequestBytes)},
	})
	if err != nil || result == nil || !result.IsError {
		t.Fatalf("oversized call was not an expected denial: result=%+v err=%v", result, err)
	}

	var auditCount int
	var phase string
	if err := pool.QueryRow(ctx, `SELECT count(*), COALESCE(max(metadata->>'phase'),'')
		FROM audit_logs WHERE org_id=$1 AND action='mcp.tool.invoked' AND target_id='runs.status'`, org).
		Scan(&auditCount, &phase); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 || phase != "request_bounds" {
		t.Fatalf("oversized invocation audit drifted: count=%d phase=%q", auditCount, phase)
	}
	var deniedCount int64
	deniedKey := fmt.Sprintf("%d:%s%s", len(org), org, user)
	if err := pool.QueryRow(ctx, `SELECT COALESCE(sum(count),0) FROM rate_limit_windows
		WHERE name='mcp.denied.request_bounds' AND key=$1`, deniedKey).Scan(&deniedCount); err != nil {
		t.Fatal(err)
	}
	if deniedCount != 1 {
		t.Fatalf("oversized invocation was not denial-rate-limited once: %d", deniedCount)
	}
}
