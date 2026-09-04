//go:build integration

package engine

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// A lock wait cancelled inside the completion transaction must not orphan
// the node until the stalled-node reaper: the worker replays the outcome and
// the node completes once the lock clears.
func TestPersistOutcomeReplaysCompletionAfterLockTimeout(t *testing.T) {
	ctx, _, _, org := newHarness(t)
	cfg, err := pgxpool.ParseConfig(os.Getenv("JANUSLY_DATABASE_URL"))
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = "300ms"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	eng := New(pool)

	// Seed a running root by hand rather than starting and claiming: a
	// shared database may have other workers racing for queued rows.
	runID := org + "-persist-run"
	wf := mustParse(t, linearDoc)
	inputJSON, err := json.Marshal(map[string]any{"workflow": json.RawMessage(linearDoc), "input": map[string]any{}})
	if err != nil {
		t.Fatalf("encode run input: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, 'persist-version', 'running', $3)`, runID, org, inputJSON); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_nodes (id, run_id, node_id, status, attempts, started_at)
		VALUES ($1, $2, 'first', 'running', 1, now()), ($3, $2, 'second', 'pending', 0, NULL)`,
		runID+"-first", runID, runID+"-second"); err != nil {
		t.Fatalf("seed nodes: %v", err)
	}
	claim := ClaimedNode{RowID: runID + "-first", RunID: runID, NodeID: "first", Attempt: 1, OrgID: org}.
		withSnapshot(wf, map[string]any{}, "", "persist-version")

	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin holder: %v", err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", runID); err != nil {
		t.Fatalf("hold completion lock: %v", err)
	}
	before := testutil.ToFloat64(metricPersistRetries.WithLabelValues("complete"))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	done := make(chan error, 1)
	go func() {
		done <- eng.persistOutcome(ctx, logger, "complete", claim, func() error {
			return eng.CompleteNode(ctx, claim, map[string]any{"ok": true})
		})
	}()
	// Longer than lock_timeout: the first attempt is cancelled on the server
	// before the holder lets go.
	time.Sleep(700 * time.Millisecond)
	if err := holder.Rollback(ctx); err != nil {
		t.Fatalf("release completion lock: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("completion must succeed once the lock clears: %v", err)
	}

	var first, second string
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT status FROM run_nodes WHERE run_id=$1 AND node_id='first'),
		(SELECT status FROM run_nodes WHERE run_id=$1 AND node_id='second')`, runID).Scan(&first, &second); err != nil {
		t.Fatalf("read node statuses: %v", err)
	}
	if first != "succeeded" || second != "queued" {
		t.Fatalf("first=%q second=%q, want succeeded/queued", first, second)
	}
	if replays := testutil.ToFloat64(metricPersistRetries.WithLabelValues("complete")) - before; replays < 1 {
		t.Fatalf("expected at least one counted replay, got %v", replays)
	}
}
