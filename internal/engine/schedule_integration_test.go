//go:build integration

package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

// seedDueSchedules saves one workflow version carrying `count` schedule
// nodes, syncs its entries, and backdates them so the next sweep owes a
// tick for every one of them.
func seedDueSchedules(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, org, workflowID string, count int) {
	t.Helper()
	q := store.New(pool)
	nodes := make([]string, 0, count)
	for i := range count {
		nodes = append(nodes, fmt.Sprintf(`{"id":"s%d","type":"schedule","config":{"cronExpression":"* * * * *"}}`, i))
	}
	doc := `{"dslVersion":"1.0","id":"` + workflowID + `","name":"scheduled","nodes":[` + strings.Join(nodes, ",") + `],"edges":[]}`
	versionID := saveWorkflowVersion(t, ctx, q, org, workflowID, doc)
	if err := eng.SyncWorkflowSchedules(ctx, q, org, workflowID, versionID, "tester", mustParse(t, doc)); err != nil {
		t.Fatalf("sync schedules: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET next_fire_at = now() - interval '1 minute' WHERE workflow_id = $1`, workflowID); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	// The sweep claims every due entry in the database; entries other
	// suites left behind (due again every minute) would dilute the counts.
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET enabled = false WHERE org_id <> $1`, org); err != nil {
		t.Fatal(err)
	}
}

// dropOrgRuns removes the runs a sweep fired (their queued roots would
// otherwise linger as work for every worker pool the rest of the suite
// starts) and the org's entries, which would come due again every minute.
func dropOrgRuns(t *testing.T, pool *pgxpool.Pool, org string) {
	t.Cleanup(func() {
		ctx := context.Background()
		for _, statement := range []string{
			`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE org_id = $1)`,
			`DELETE FROM run_nodes WHERE run_id IN (SELECT id FROM runs WHERE org_id = $1)`,
			`DELETE FROM runs WHERE org_id = $1`,
			`DELETE FROM schedule_entries WHERE org_id = $1`,
		} {
			if _, err := pool.Exec(ctx, statement, org); err != nil {
				t.Logf("cleanup %s: %v", org, err)
			}
		}
	})
}

func countOrgRuns(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE org_id = $1`, org).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Two replicas sweeping at once split the due entries under SKIP LOCKED;
// every due tick fires exactly one run.
func TestScheduleSweepFiresEachDueTickOnceAcrossConcurrentSweeps(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	seedDueSchedules(t, ctx, pool, eng, org, "wf-sched-"+org, 3)

	var wg sync.WaitGroup
	results := make([]int, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			fired, _, err := eng.SweepDueSchedules(ctx)
			if err != nil {
				t.Errorf("sweep %d: %v", i, err)
			}
			results[i] = fired
		}(i)
	}
	wg.Wait()
	if fired := results[0] + results[1]; fired != 3 {
		t.Fatalf("want 3 ticks fired across both sweeps, got %d (%v)", fired, results)
	}
	if runs := countOrgRuns(t, ctx, pool, org); runs != 3 {
		t.Fatalf("want exactly 3 runs, got %d", runs)
	}
	var unrecorded int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM schedule_entries WHERE org_id = $1 AND last_run_id IS NULL`, org).Scan(&unrecorded)
	if unrecorded != 0 {
		t.Fatalf("%d entries fired without recording their run", unrecorded)
	}
}

// A lease that lapses mid-batch (or a crash between the run insert and the
// clock advance) lets a second attempt re-claim the same logical tick; the
// idempotency key keyed on the due time makes that attempt a replay.
func TestScheduleTickReclaimedAfterLeaseExpiryDoesNotDoubleFire(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	seedDueSchedules(t, ctx, pool, eng, org, "wf-lease-"+org, 1)
	q := store.New(pool)
	now := time.Now().UTC()
	lease := now.Add(time.Minute)
	claimed, err := q.ClaimDueScheduleEntries(ctx, store.ClaimDueScheduleEntriesParams{Now: &now, LeaseUntil: &lease, RowLimit: 10})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %v (%d rows)", err, len(claimed))
	}
	entry := claimed[0]
	if !eng.fireScheduleEntry(ctx, entry, now, nil) {
		t.Fatal("first attempt must fire")
	}
	if eng.fireScheduleEntry(ctx, entry, now, nil) {
		t.Fatal("the same logical tick must not fire twice")
	}
	if runs := countOrgRuns(t, ctx, pool, org); runs != 1 {
		t.Fatalf("want 1 run for a replayed tick, got %d", runs)
	}
}

// A full batch of 200 entries on one version parses that version once and
// completes well inside the lease.
func TestScheduleSweepParsesEachVersionOnceAndStaysWithinTheLease(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	counter := &queryCounter{}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	raw := make([]byte, 6)
	_, _ = rand.Read(raw)
	org := "org-sched-" + hex.EncodeToString(raw)
	eng := New(pool)
	dropOrgRuns(t, pool, org)
	seedDueSchedules(t, ctx, pool, eng, org, "wf-batch-"+org, scheduleSweepLimit)

	counter.reset()
	started := time.Now()
	fired, dropped, err := eng.SweepDueSchedules(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if fired != scheduleSweepLimit || dropped != 0 {
		t.Fatalf("want %d fired / 0 dropped, got %d / %d", scheduleSweepLimit, fired, dropped)
	}
	if elapsed := time.Since(started); elapsed >= scheduleSweepWallBudget {
		t.Fatalf("a full batch took %v, over the %v budget", elapsed, scheduleSweepWallBudget)
	}
	if reads := counter.get("GetWorkflowVersionByID"); reads != 1 {
		t.Fatalf("one version behind %d entries must be read once per sweep, got %d reads", scheduleSweepLimit, reads)
	}
}
