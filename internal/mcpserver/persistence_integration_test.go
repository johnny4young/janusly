//go:build integration

package mcpserver

import (
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/grammar"
)

func TestInvocationAuditUsesInjectedPolicy(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	policy, err := grammar.NewPersister(2)
	if err != nil {
		t.Fatal(err)
	}
	deps := Deps{Pool: pool, Audit: audit.NewWriter(policy), OrgID: fmt.Sprintf("mcp-policy-%d", time.Now().UnixNano()), UserID: "mcp-user"}
	t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "900000")
	deps.auditToolDecision(t.Context(), "probe", []string{"runs.read"}, false, false, "permission_denied", "guard")
	var raw string
	if err := pool.QueryRow(t.Context(), `SELECT metadata::text FROM audit_logs WHERE org_id=$1 AND action='mcp.tool.invoked'`, deps.OrgID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw != "{}" {
		t.Fatalf("MCP invocation ignored writer: %s", raw)
	}
}
