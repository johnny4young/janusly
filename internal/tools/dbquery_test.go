package tools

import (
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
