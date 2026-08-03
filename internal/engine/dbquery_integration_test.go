//go:build integration

package engine

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/tools"
)

// The db.* loop through the engine chokepoint: schema describe, bounded
// read, write, transaction atomicity (mid-flight failure rolls back), SQL
// validation before any connection, no DSN echo, and one usage row per
// call. The "customer database" is a scratch table reached through its
// own stored postgres credential.
func TestDbQueryToolsLoop(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	tools.ResetDbPoolsForTests()
	t.Cleanup(tools.ResetDbPoolsForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)
	q := store.New(pool)
	org := fmt.Sprintf("org-db-%d", time.Now().UnixNano())

	table := fmt.Sprintf("customer_orders_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, fmt.Sprintf(
		`CREATE TABLE %s (id text primary key, status text not null, total numeric not null)`, table)); err != nil {
		t.Fatalf("scratch table: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), "DROP TABLE IF EXISTS "+table) })
	if _, err := pool.Exec(ctx, fmt.Sprintf(
		`INSERT INTO %s VALUES ('ord-1', 'pending', 99.50), ('ord-2', 'paid', 12.00)`, table)); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Managed credential of kind postgres whose secret IS the DSN.
	credID := "cred-" + org
	if err := q.InsertCredential(ctx, store.InsertCredentialParams{
		ID: credID, OrgID: org, Name: "customer-postgres", Kind: "postgres", SecretRef: "PLACEHOLDER",
		CreatedBy: pgtype.Text{String: "test", Valid: true},
	}); err != nil {
		t.Fatalf("credential: %v", err)
	}
	_, _, secretRef, err := secretstore.CreateCredentialSecretVersion(ctx, q, struct {
		ID           string
		OrgID        string
		CredentialID string
		SecretValue  string
		CreatedBy    string
	}{OrgID: org, CredentialID: credID, SecretValue: dsn})
	if err != nil {
		t.Fatalf("secret: %v", err)
	}
	if err := q.UpdateCredentialSecretRef(ctx, store.UpdateCredentialSecretRefParams{
		OrgID: org, ID: credID, SecretRef: secretRef,
	}); err != nil {
		t.Fatalf("ref: %v", err)
	}

	deps := eng.buildIntegrationDeps(org, "run-db", "node-db")
	call := func(tool string, input map[string]any) map[string]any {
		input["credential"] = "customer-postgres"
		return tools.ExecuteIntegrationTool(ctx, tool, input, deps)
	}

	// describe: only the scratch table, shaped columns.
	result := call("db.schema.describe", map[string]any{"schema": "public", "tables": []any{table}})
	if result["ok"] != true || len(result["tables"].([]any)) != 1 {
		t.Fatalf("describe: %+v", result)
	}
	described := result["tables"].([]any)[0].(map[string]any)
	if described["name"] != table || len(described["columns"].([]any)) != 3 {
		t.Fatalf("described shape: %+v", described)
	}

	// read: parameterized + bounded (maxRows 1 → truncated).
	result = call("db.query.read", map[string]any{
		"sql":     fmt.Sprintf("select id, status from %s where status = $1 order by id", table),
		"params":  []any{"pending"},
		"maxRows": 1.0,
	})
	if result["ok"] != true || len(result["rows"].([]any)) != 1 {
		t.Fatalf("read: %+v", result)
	}
	result = call("db.query.read", map[string]any{
		"sql": fmt.Sprintf("select id from %s order by id", table), "maxRows": 1.0,
	})
	if result["ok"] != true || result["truncated"] != true {
		t.Fatalf("bounded read must truncate: %+v", result)
	}

	// write: the customer row actually changes.
	result = call("db.query.write", map[string]any{
		"sql":    fmt.Sprintf("update %s set status = $1 where id = $2", table),
		"params": []any{"paid", "ord-1"},
	})
	if result["ok"] != true {
		t.Fatalf("write: %+v", result)
	}
	var status string
	_ = pool.QueryRow(ctx, fmt.Sprintf("select status from %s where id = 'ord-1'", table)).Scan(&status)
	if status != "paid" {
		t.Fatalf("write must land: %s", status)
	}

	// transaction: a failing second statement rolls back the first.
	result = call("db.query.transaction", map[string]any{
		"statements": []any{
			map[string]any{"sql": fmt.Sprintf("update %s set status = $1 where id = $2", table), "params": []any{"void", "ord-2"}},
			map[string]any{"sql": fmt.Sprintf("insert into %s (id) values ($1)", table), "params": []any{"ord-3"}},
		},
	})
	if result["ok"] != false {
		t.Fatalf("failing transaction: %+v", result)
	}
	_ = pool.QueryRow(ctx, fmt.Sprintf("select status from %s where id = 'ord-2'", table)).Scan(&status)
	if status != "paid" {
		t.Fatalf("failed transaction must roll back: %s", status)
	}
	if message, _ := result["error"].(string); strings.Contains(message, "postgres://") {
		t.Fatalf("error must not echo the DSN: %s", message)
	}
	// A green transaction commits both statements.
	result = call("db.query.transaction", map[string]any{
		"statements": []any{
			map[string]any{"sql": fmt.Sprintf("update %s set status = $1 where id = $2", table), "params": []any{"void", "ord-2"}},
			map[string]any{"sql": fmt.Sprintf("select status from %s where id = $1", table), "params": []any{"ord-2"}},
		},
	})
	if result["ok"] != true || len(result["results"].([]any)) != 2 {
		t.Fatalf("green transaction: %+v", result)
	}

	// Validation rejects before any connection or rate budget.
	result = call("db.query.read", map[string]any{"sql": "select 1; drop table " + table})
	if result["ok"] != false || !strings.Contains(result["error"].(string), "semicolon") {
		t.Fatalf("sql validation: %+v", result)
	}
	result = call("db.query.write", map[string]any{"sql": "select 1"})
	if result["ok"] != false || !strings.Contains(result["error"].(string), "INSERT, UPDATE, or DELETE") {
		t.Fatalf("verb-class validation: %+v", result)
	}

	// Ghost credentials answer the generic gate message.
	result = tools.ExecuteIntegrationTool(ctx, "db.query.read",
		map[string]any{"credential": "ghost", "sql": "select 1"}, deps)
	if result["ok"] != false || result["error"] != "credential not found: ghost" {
		t.Fatalf("ghost credential: %+v", result)
	}

	// Usage rows: one per executed OR validated call through the recorder.
	var usageRows int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM usage_events WHERE org_id = $1 AND metric LIKE 'tool.db.%'`, org).Scan(&usageRows)
	if usageRows < 6 {
		t.Fatalf("usage rows: %d", usageRows)
	}
}
