package tools

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// A credential's secretRef may point at a process environment variable
// (the documented legacy provider). pgx quotes the whole connection
// string verbatim when it cannot parse it, and neither the postgres://
// regex nor the secret-SHAPE scrubber can recognise an arbitrary value —
// so the resolved secret used to travel back to the workflow author
// inside the tool's error envelope. safeDbError now redacts by VALUE.
func TestSafeDbErrorRedactsResolvedSecret(t *testing.T) {
	secret := "jns_svc_tok_9f3c1e77aa42b8d0c5e6"
	_, err := pgxpool.ParseConfig(secret)
	if err == nil {
		t.Fatal("expected an unparseable DSN for the probe")
	}
	if raw := err.Error(); !strings.Contains(raw, secret) {
		t.Fatalf("probe assumption broken — pgx no longer quotes the DSN: %s", raw)
	}
	scrubbed := safeDbError(err, secret)
	if strings.Contains(scrubbed, secret) {
		t.Fatalf("resolved secret survived redaction: %s", scrubbed)
	}
	if !strings.Contains(scrubbed, "[redacted]") {
		t.Fatalf("expected the redaction sentinel: %s", scrubbed)
	}
	// A postgres:// DSN keeps its dedicated sentinel.
	_, urlErr := pgxpool.ParseConfig("postgres://u:p@host:5432/db?bad=%%")
	if urlErr != nil && strings.Contains(safeDbError(urlErr), "p@host") {
		t.Fatal("connection URL must stay redacted")
	}
}
