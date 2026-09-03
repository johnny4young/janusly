package tools

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// The closed statement grammar: every rejection class, both verb classes,
// and the placeholder contract.
func TestValidateDbSQL(t *testing.T) {
	if message := ValidateDbSQL("select id from customers where status = $1", 1, "read"); message != "" {
		t.Fatalf("valid read rejected: %s", message)
	}
	if message := ValidateDbSQL("update customers set status = $1 where id = $2", 2, "write"); message != "" {
		t.Fatalf("valid write rejected: %s", message)
	}

	rejections := map[string]struct {
		sql    string
		params int
		kind   string
	}{
		"sql is required":            {"   ", 0, "read"},
		"no semicolon":               {"select 1; drop table customers", 0, "read"},
		"comments":                   {"select 1 -- sneak", 0, "read"},
		"verb is not allowed":        {"drop table customers", 0, "any"},
		"session control":            {"begin", 0, "any"},
		"only accepts SELECT":        {"update customers set a = 1", 0, "read"},
		"only accepts INSERT":        {"select 1", 0, "write"},
		"start at $1":                {"select $0", 1, "read"},
		"contiguous from $1":         {"select $1, $3", 2, "read"},
		"params length (1)":          {"select $1, $2", 1, "read"},
		"transactions accept only":   {"vacuum full", 0, "any"},
		"copy is dangerous anywhere": {"copy customers to stdout", 0, "any"},
	}
	for label, item := range rejections {
		message := ValidateDbSQL(item.sql, item.params, item.kind)
		if message == "" {
			t.Fatalf("%s: %q must be rejected", label, item.sql)
		}
	}
	// Oversized SQL.
	if message := ValidateDbSQL("select "+strings.Repeat("1,", 20_000)+"1", 0, "read"); message != "sql is too large" {
		t.Fatalf("oversized sql: %s", message)
	}
}

func TestDbRegistrySemanticContract(t *testing.T) {
	registry := NewRegistry()
	if err := registry.ValidatePartialInput("db.query.read", map[string]any{
		"credential": "customer-postgres", "sql": "select $1",
	}); err != nil {
		t.Fatalf("partial proposal may leave the parameter binding unresolved: %v", err)
	}
	if err := registry.ValidateInput("db.query.read", map[string]any{
		"credential": "customer-postgres", "sql": "select $1",
	}); err == nil || !strings.Contains(err.Error(), "params length") {
		t.Fatalf("persisted query must close placeholder bindings: %v", err)
	}
	if err := registry.ValidateInput("db.query.read", map[string]any{
		"credential": "customer-postgres", "sql": "select $1", "params": []string{"active"},
		"maxRows": 10, "timeoutMs": json.Number("30000"),
	}); err != nil {
		t.Fatalf("safe Go-native numbers and typed params should validate: %v", err)
	}
	if err := registry.ValidateInput("db.schema.describe", map[string]any{
		"credential": "customer-postgres", "schema": "public", "tables": []string{"customers"},
	}); err != nil {
		t.Fatalf("typed table lists should validate: %v", err)
	}
	if err := registry.ValidateInput("db.query.transaction", map[string]any{
		"credential": "customer-postgres",
		"statements": []map[string]any{{"sql": "update customers set status = $1", "params": []string{"active"}}},
	}); err != nil {
		t.Fatalf("typed transaction lists should validate: %v", err)
	}

	tests := []struct {
		name    string
		tool    string
		input   map[string]any
		message string
	}{
		{name: "blank credential", tool: "db.query.read", input: map[string]any{"credential": " ", "sql": "select 1"}, message: "credential must be a trimmed"},
		{name: "fractional rows", tool: "db.query.read", input: map[string]any{"credential": "db", "sql": "select 1", "maxRows": 1.5}, message: "whole number"},
		{name: "excess timeout", tool: "db.query.read", input: map[string]any{"credential": "db", "sql": "select 1", "timeoutMs": dbTimeoutMsMax + 1}, message: "timeoutMs"},
		{name: "write through read", tool: "db.query.read", input: map[string]any{"credential": "db", "sql": "update customers set active = true"}, message: "only accepts SELECT"},
		{name: "duplicate tables", tool: "db.schema.describe", input: map[string]any{"credential": "db", "tables": []string{"Customers", "customers"}}, message: "unique case-insensitively"},
		{name: "unsafe schema", tool: "db.schema.describe", input: map[string]any{"credential": "db", "schema": "public;drop"}, message: "simple Postgres identifier"},
		{name: "oversized params", tool: "db.query.read", input: map[string]any{"credential": "db", "sql": "select $1", "params": []any{strings.Repeat("x", dbParamsMaxBytes)}}, message: "params exceed"},
		{name: "unknown transaction field", tool: "db.query.transaction", input: map[string]any{
			"credential": "db", "statements": []any{map[string]any{"sql": "select 1", "retry": true}},
		}, message: "unsupported field retry"},
		{name: "empty transaction", tool: "db.query.transaction", input: map[string]any{"credential": "db", "statements": []any{}}, message: "1..10"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := registry.ValidateInput(test.tool, test.input)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected %q rejection, got %v", test.message, err)
			}
		})
	}
}

func TestDbBoundedIntAcceptsEverySafeIntegerRepresentation(t *testing.T) {
	for _, value := range []any{1, int32(2), uint64(3), float64(4), json.Number("5")} {
		got, message := dbBoundedInt(map[string]any{"limit": value}, "limit", 10, 10)
		if message != "" || got < 1 || got > 10 {
			t.Fatalf("value %#v rejected: got=%d message=%q", value, got, message)
		}
	}
}

// The static write-capability bit drives the sandbox dry-run skip.
func TestDbToolsWriteSideBits(t *testing.T) {
	registry := NewRegistry()
	for name, expected := range map[string]bool{
		"db.schema.describe": false, "db.query.read": false,
		"db.query.write": true, "db.query.transaction": true,
	} {
		if registry.IsWriteSide(name) != expected {
			t.Fatalf("%s writeSide must be %v", name, expected)
		}
	}
}

// Connection URLs and secret shapes never leave the envelope.
func TestSafeDbError(t *testing.T) {
	scrubbed := safeDbError(errors.New(`connect failed: postgres://user:hunter2@db.internal:5432/prod (token sk-abcdefghijklmnopqrstuvwxyz0123456789)`))
	if strings.Contains(scrubbed, "hunter2") || strings.Contains(scrubbed, "postgres://") ||
		strings.Contains(scrubbed, "sk-abcdefghijklmnop") {
		t.Fatalf("secret material leaked: %s", scrubbed)
	}
	if safeDbError(nil) != "database query failed" {
		t.Fatal("nil error needs the generic message")
	}
}
