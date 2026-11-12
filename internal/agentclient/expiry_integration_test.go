//go:build integration

package agentclient

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

// The longest expiry is exactly 90 × 24 hours, whatever the session time zone:
// a calendar interval would shrink across a daylight-saving change.
func TestMaximumExpiryHoldsAcrossDaylightSaving(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL TimeZone = 'America/New_York'`); err != nil {
		t.Fatal(err)
	}
	// January to April crosses the spring-forward change.
	issuedAt := time.Date(2027, time.January, 15, 17, 0, 0, 0, time.UTC)
	org := fmt.Sprintf("org-expiry-%d", time.Now().UnixNano())
	issued, err := Issue(ctx, store.New(tx), "client-"+org, issuedAt, IssueInput{
		OrgID: org, CreatedBy: "user-1", Name: "dst", Capabilities: []string{"read"}, ExpiresInDays: MaxExpiryDays,
	}, map[string]bool{"workflows.read": true, "runs.read": true, "dlq.read": true, "recovery.read": true, "credentials.read": true})
	if err != nil {
		t.Fatalf("a %d-day client crossing daylight saving was refused: %v", MaxExpiryDays, err)
	}
	if got := issued.Client.ExpiresAt.Sub(issued.Client.TokenIssuedAt); got != MaxExpiryDays*24*time.Hour {
		t.Fatalf("lifetime = %s", got)
	}
	if _, err := tx.Exec(ctx, `SAVEPOINT longer`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_clients SET expires_at = expires_at + interval '1 second' WHERE id = $1`, issued.Client.ID); err == nil {
		t.Fatal("an expiry past 90 × 24 hours was accepted")
	}
}
