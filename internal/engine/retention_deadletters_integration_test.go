//go:build integration

package engine

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// dead_letters had no retention. Settled rows (replayed, resolved) now age
// out under retention.deadLettersDays; open rows never do.
func TestDeadLetterRetentionPurgesSettledRowsOnly(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	eng := New(pool)
	org := fmt.Sprintf("org-dlq-ret-%d", time.Now().UnixNano())
	old := time.Now().UTC().AddDate(0, 0, -40)
	fresh := time.Now().UTC().AddDate(0, 0, -1)

	// The org scan lists orgs with aged run events; this org has one.
	runID := "run-" + org
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id) VALUES ($1, $2, 'failed', '{}', 'wv-dlq')`, runID, org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_events (id, run_id, type, payload, created_at) VALUES ($1, $2, 'run.failed', '{}', $3)`, runID+"-ev", runID, old); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'retention.deadLettersDays', '30', 'retention', 'test', 'number')`, org+"-dlq-days", org); err != nil {
		t.Fatal(err)
	}
	seed := func(id, status string, at time.Time) {
		if _, err := pool.Exec(ctx, `INSERT INTO dead_letters (id, org_id, run_id, node_id, workflow_json, node_json, error_json, status, created_at)
			VALUES ($1, $2, $3, 'step', '{}', '{}', '{"message":"x"}', $4, $5)`, org+"-"+id, org, runID, status, at); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	seed("old-replayed", "replayed", old)
	seed("old-resolved", "resolved", old)
	seed("old-open", "open", old)
	seed("fresh-replayed", "replayed", fresh)

	if _, err := eng.ProcessDataRetentionSweep(ctx, 100, 10); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	remaining := map[string]bool{}
	rows, err := pool.Query(ctx, `SELECT id FROM dead_letters WHERE org_id = $1`, org)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		remaining[id] = true
	}
	rows.Close()
	for id, want := range map[string]bool{"old-replayed": false, "old-resolved": false, "old-open": true, "fresh-replayed": true} {
		if remaining[org+"-"+id] != want {
			t.Fatalf("%s: kept=%v want kept=%v (remaining %v)", id, remaining[org+"-"+id], want, remaining)
		}
	}
}
