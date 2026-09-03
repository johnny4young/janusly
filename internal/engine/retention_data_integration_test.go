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

// The per-org batched data retention: each table purges only its own
// window and org, legal holds exempt rows, seeded volume drains across
// multiple bounded batches, and the runaway cap reports capped.
func TestDataRetentionSweepPerOrgBatched(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)

	stamp := time.Now().UnixNano()
	narrowOrg := fmt.Sprintf("org-ret-narrow-%d", stamp)
	wideOrg := fmt.Sprintf("org-ret-wide-%d", stamp)
	old := time.Now().UTC().AddDate(0, 0, -40)
	fresh := time.Now().UTC().AddDate(0, 0, -1)

	// Seed: one run per org; the narrow org gets 250 expired events, 5
	// fresh ones, and 1 expired-but-held; the wide org gets 50 expired.
	seedRun := func(org string) string {
		runID := "run-" + org
		if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
			VALUES ($1, $2, 'succeeded', '{}', 'wv-ret')`, runID, org); err != nil {
			t.Fatalf("seed run: %v", err)
		}
		return runID
	}
	narrowRun, wideRun := seedRun(narrowOrg), seedRun(wideOrg)
	seedEvents := func(runID, tag string, count int, at time.Time, hold *time.Time) {
		for i := range count {
			if _, err := pool.Exec(ctx, `INSERT INTO run_events (id, run_id, type, payload, created_at, hold_until)
				VALUES ($1, $2, 'node.succeeded', '{}', $3, $4)`,
				fmt.Sprintf("%s-ev-%s-%d", runID, tag, i), runID, at, hold); err != nil {
				t.Fatalf("seed events: %v", err)
			}
		}
	}
	held := time.Now().UTC().AddDate(0, 0, 30)
	seedEvents(narrowRun, "old", 250, old, nil)
	seedEvents(narrowRun, "fresh", 5, fresh, nil)
	seedEvents(narrowRun, "held", 1, old, &held)
	seedEvents(wideRun, "old", 50, old, nil)

	// Windows: narrow org purges at 30 days; wide org at 60 keeps its
	// 40-day-old rows. usage_events for the narrow org: 30 expired rows.
	setWindow := func(org, key string, days int) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'retention', 'test', 'number')`,
			org+"-"+key, org, key, fmt.Sprint(days)); err != nil {
			t.Fatalf("set window: %v", err)
		}
	}
	setWindow(narrowOrg, "retention.runEventsDays", 30)
	setWindow(wideOrg, "retention.runEventsDays", 60)
	setWindow(narrowOrg, "retention.usageEventsDays", 30)
	for i := range 30 {
		if _, err := pool.Exec(ctx, `INSERT INTO usage_events (id, org_id, metric, quantity, created_at)
			VALUES ($1, $2, 'llm.completion', 1, $3)`,
			fmt.Sprintf("%s-use-%d", narrowOrg, i), narrowOrg, old); err != nil {
			t.Fatalf("seed usage: %v", err)
		}
	}

	// Tiny batches force the loop: 250 expired rows over batchSize 100
	// need 3 batches; maxBatches 2 caps the first sweep truthfully.
	capped, err := eng.ProcessDataRetentionSweep(ctx, 100, 2)
	if err != nil {
		t.Fatalf("capped sweep: %v", err)
	}
	first := capped[narrowOrg+"/run_events"]
	if first.RowsDeleted != 200 || !first.CappedByMaxBatches {
		t.Fatalf("capped sweep shape: %+v", first)
	}

	// The next fire drains the remainder and reports uncapped.
	rest, err := eng.ProcessDataRetentionSweep(ctx, 100, 0)
	if err != nil {
		t.Fatalf("drain sweep: %v", err)
	}
	second := rest[narrowOrg+"/run_events"]
	if second.RowsDeleted != 50 || second.CappedByMaxBatches {
		t.Fatalf("drain shape: %+v", second)
	}
	// usage_events (30 rows < one batch) drained already in sweep one.
	if usage := capped[narrowOrg+"/usage_events"]; usage.RowsDeleted != 30 {
		t.Fatalf("usage purge: %+v", usage)
	}

	// Survivors: fresh rows + the legal hold; the wide org untouched.
	countEvents := func(runID string) int {
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1`, runID).Scan(&n)
		return n
	}
	if got := countEvents(narrowRun); got != 6 { // 5 fresh + 1 held
		t.Fatalf("narrow survivors: %d", got)
	}
	if got := countEvents(wideRun); got != 50 {
		t.Fatalf("wide org must keep its rows inside the 60-day window: %d", got)
	}
}
