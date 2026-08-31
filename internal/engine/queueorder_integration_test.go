//go:build integration

package engine

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

func queueOrderTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test-integration`")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("open queue-order database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedQueueOrderRun(t *testing.T, pool *pgxpool.Pool, runID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
		 VALUES ($1, 'org-queue-order', 'running', '{}', 'wv-queue-order')`, runID); err != nil {
		t.Fatalf("seed queue-order run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM run_wakeups
			WHERE run_node_id IN (SELECT id FROM run_nodes WHERE run_id = $1)`, runID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM run_nodes WHERE run_id = $1`, runID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM runs WHERE id = $1`, runID)
	})
}

func TestClaimIsFIFOInsteadOfStableUUIDOrder(t *testing.T) {
	pool := queueOrderTestPool(t)
	ctx := context.Background()
	runID := fmt.Sprintf("run-fifo-%d", time.Now().UnixNano())
	seedQueueOrderRun(t, pool, runID)

	// Arrival order is first, second, third. IDs sort in exactly the opposite
	// order, so the former ORDER BY id would deterministically starve `first`
	// behind both newer rows under a sustained backlog.
	arrivals := []struct {
		id   string
		node string
		age  int
	}{
		{"z-" + runID, "first", 300},
		{"m-" + runID, "second", 200},
		{"a-" + runID, "third", 100},
	}
	for _, arrival := range arrivals {
		if _, err := pool.Exec(ctx,
			`INSERT INTO run_nodes (id, run_id, node_id, status, enqueued_at)
			 VALUES ($1, $2, $3, 'queued', clock_timestamp() - make_interval(secs => $4))`,
			arrival.id, runID, arrival.node, arrival.age); err != nil {
			t.Fatalf("seed %s: %v", arrival.node, err)
		}
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin claim: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	claimed, err := store.New(tx).LockClaimableRunNodes(ctx, 10_000)
	if err != nil {
		t.Fatalf("claim queue: %v", err)
	}

	seedIDs := map[string]bool{}
	for _, arrival := range arrivals {
		seedIDs[arrival.id] = true
	}
	got := make([]string, 0, len(arrivals))
	for _, id := range claimed {
		if seedIDs[id] {
			got = append(got, id)
		}
	}
	want := []string{arrivals[0].id, arrivals[1].id, arrivals[2].id}
	if !slices.Equal(got, want) {
		t.Fatalf("queue must claim oldest-first: got %v want %v", got, want)
	}
}

func TestEveryTransitionIntoQueuedRefreshesEnqueuedAt(t *testing.T) {
	pool := queueOrderTestPool(t)
	ctx := context.Background()
	runID := fmt.Sprintf("run-queue-stamp-%d", time.Now().UnixNano())
	seedQueueOrderRun(t, pool, runID)
	started := time.Now().Add(-time.Second)

	for _, seed := range []struct {
		node   string
		status string
	}{
		{"from-pending", "pending"},
		{"from-running", "running"},
		{"from-failed", "failed"},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO run_nodes (id, run_id, node_id, status, attempts, enqueued_at)
			 VALUES ($1, $2, $3, $4, 1, clock_timestamp() - interval '1 hour')`,
			seed.node+"-"+runID, runID, seed.node, seed.status); err != nil {
			t.Fatalf("seed %s: %v", seed.node, err)
		}
	}

	q := store.New(pool)
	if affected, err := q.QueueRunNode(ctx, store.QueueRunNodeParams{
		RunID: runID, NodeID: "from-pending",
	}); err != nil || affected != 1 {
		t.Fatalf("queue pending node: affected=%d error=%v", affected, err)
	}
	wakeAt := time.Now().Add(time.Minute)
	if affected, err := q.RequeueRunNodeForRetry(ctx, store.RequeueRunNodeForRetryParams{
		Attempt: pgtype.Int4{Int32: 2, Valid: true}, WakeAt: &wakeAt,
		RunID: runID, NodeID: "from-running",
	}); err != nil || affected != 1 {
		t.Fatalf("requeue running node: affected=%d error=%v", affected, err)
	}
	if _, err := q.RedriveFailedRunNode(ctx, store.RedriveFailedRunNodeParams{
		RunID: runID, NodeID: "from-failed",
	}); err != nil {
		t.Fatalf("redrive failed node: %v", err)
	}

	rows, err := pool.Query(ctx,
		`SELECT node_id, enqueued_at
		 FROM run_nodes WHERE run_id = $1 AND status = 'queued'`, runID)
	if err != nil {
		t.Fatalf("read queue clocks: %v", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var node string
		var enqueuedAt time.Time
		if err := rows.Scan(&node, &enqueuedAt); err != nil {
			t.Fatalf("scan queue clock: %v", err)
		}
		if node == "from-running" {
			if delta := enqueuedAt.Sub(wakeAt); delta < -100*time.Millisecond || delta > 100*time.Millisecond {
				t.Fatalf("retry queue clock = %s, want wake time %s", enqueuedAt, wakeAt)
			}
		} else if enqueuedAt.Before(started) || enqueuedAt.After(time.Now().Add(time.Second)) {
			t.Fatalf("%s kept a stale queue clock: %s", node, enqueuedAt)
		}
		seen++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate queue clocks: %v", err)
	}
	if seen != 3 {
		t.Fatalf("expected all three transition paths, saw %d", seen)
	}
}

func TestClaimReturnsEligibleQueueWait(t *testing.T) {
	pool := queueOrderTestPool(t)
	ctx := context.Background()
	runID := fmt.Sprintf("run-queue-wait-%d", time.Now().UnixNano())
	seedQueueOrderRun(t, pool, runID)
	id := "queue-wait-" + runID
	if _, err := pool.Exec(ctx,
		`INSERT INTO run_nodes (id, run_id, node_id, status, enqueued_at)
		 VALUES ($1, $2, 'waited', 'queued', clock_timestamp() - interval '2 seconds')`,
		id, runID); err != nil {
		t.Fatalf("seed waited node: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin claim: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	ids, err := q.LockClaimableRunNodes(ctx, 100)
	if err != nil {
		t.Fatalf("lock waited node: %v", err)
	}
	if !slices.Contains(ids, id) {
		t.Fatalf("eligible node %q was not claimable: %v", id, ids)
	}
	claimed, err := q.MarkLockedNodesRunning(ctx, []string{id})
	if err != nil {
		t.Fatalf("mark waited node running: %v", err)
	}
	if len(claimed) != 1 {
		t.Fatalf("marked rows = %d, want 1", len(claimed))
	}
	if got := claimed[0].QueueWaitSeconds; got < 1.5 || got > 10 {
		t.Fatalf("eligible queue wait = %.3fs, want about 2s", got)
	}
}

func TestClaimPlanUsesFIFOQueueIndex(t *testing.T) {
	pool := queueOrderTestPool(t)
	ctx := context.Background()
	rows, err := pool.Query(ctx, `EXPLAIN (COSTS OFF)
		SELECT rn.id
		FROM run_nodes rn
		JOIN runs r ON r.id = rn.run_id
		WHERE rn.status = 'queued' AND r.status = 'running'
		  AND rn.enqueued_at <= now()
		  AND NOT EXISTS (
		    SELECT 1 FROM run_wakeups w
		    WHERE w.run_node_id = rn.id AND w.wake_at > now()
		  )
		ORDER BY rn.enqueued_at, rn.id
		LIMIT 8
		FOR UPDATE OF rn SKIP LOCKED`)
	if err != nil {
		t.Fatalf("explain claim: %v", err)
	}
	defer rows.Close()
	var plan strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("scan claim plan: %v", err)
		}
		plan.WriteString(line)
		plan.WriteByte('\n')
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate claim plan: %v", err)
	}
	if !strings.Contains(plan.String(), "run_nodes_queued_claim_idx") {
		t.Fatalf("claim did not use the FIFO partial index:\n%s", plan.String())
	}
	if strings.Contains(plan.String(), "Seq Scan on run_nodes") {
		t.Fatalf("claim scanned accumulated run-node history:\n%s", plan.String())
	}
}
