//go:build integration

package engine

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

// Generation-bound terminal impact: a redriven node's terminal SUCCESS —
// and only that — credits exactly one impact event (idempotent on the
// dead letter) plus the O(1) rollup; initiation credits nothing; a
// failed redrive credits nothing; the second redrive of the same dead
// letter cannot double-count.
func TestRecoveryImpactPipeline(t *testing.T) {
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
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()
	org := fmt.Sprintf("org-impact-%d", time.Now().UnixNano())

	var healed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healed.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	wf := &domain.Workflow{
		ID: "wf-impact", Name: "Impact", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "call", Type: "http", Config: map[string]any{
			"url": upstream.URL, "timeoutMs": 500,
		}}},
		Edges: []domain.Edge{},
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitRunStatus(t, pool, runID, "failed", 0)
	var deadLetterID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID)

	impactCount := func() int {
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM recovery_impact_events WHERE org_id = $1`, org).Scan(&n)
		return n
	}

	// 1. A redrive against a STILL-BROKEN upstream terminally fails again:
	// initiation is never a recovered win — zero impact.
	if err := eng.RedriveDeadLetter(ctx, org, deadLetterID); err != nil {
		t.Fatalf("redrive 1: %v", err)
	}
	waitRunStatus(t, pool, runID, "failed", 0)
	if impactCount() != 0 {
		t.Fatalf("failed redrive must credit nothing: %d", impactCount())
	}
	// The failure re-captures a NEW dead letter for the next attempt.
	var openDeadLetterID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1 AND status = 'open'
		ORDER BY created_at DESC LIMIT 1`, runID).Scan(&openDeadLetterID)
	if openDeadLetterID == "" {
		t.Fatal("second failure must capture an open dead letter")
	}

	// 2. Heal + redrive: the terminal success credits EXACTLY one event +
	// the rollup, and the dead letter converges to replayed.
	healed.Store(true)
	if err := eng.RedriveDeadLetter(ctx, org, openDeadLetterID); err != nil {
		t.Fatalf("redrive 2: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	if impactCount() != 1 {
		t.Fatalf("terminal success must credit exactly one impact: %d", impactCount())
	}
	var total int
	var downtime int64
	_ = pool.QueryRow(ctx, `SELECT total_recovered, downtime_ended_ms FROM recovery_impact_rollups WHERE org_id = $1`, org).
		Scan(&total, &downtime)
	if total != 1 || downtime <= 0 {
		t.Fatalf("rollup must count one production win: %d/%d", total, downtime)
	}
	var dlStatus string
	_ = pool.QueryRow(ctx, `SELECT status FROM dead_letters WHERE id = $1`, openDeadLetterID).Scan(&dlStatus)
	if dlStatus != "replayed" {
		t.Fatalf("dead letter must converge to replayed: %s", dlStatus)
	}

	// 3. Idempotency under identical re-credit: inserting the same impact
	// event again is a no-op (unique dead_letter_id).
	var inserted int64
	res, err := pool.Exec(ctx, `INSERT INTO recovery_impact_events
		(dead_letter_id, org_id, run_id, node_id, recovered_at, downtime_ended_ms)
		VALUES ($1, $2, $3, 'call', now(), 1) ON CONFLICT (dead_letter_id) DO NOTHING`,
		openDeadLetterID, org, runID)
	if err != nil {
		t.Fatalf("re-credit: %v", err)
	}
	inserted = res.RowsAffected()
	if inserted != 0 || impactCount() != 1 {
		t.Fatalf("double credit must be impossible: inserted=%d count=%d", inserted, impactCount())
	}

	// 4. A VALIDATION replay's win records its fact but never the rollup.
	sandboxRunID, err := eng.ReplayDeadLetterAsValidation(ctx, org, openDeadLetterID, wf, "tester")
	if err != nil {
		t.Fatalf("sandbox: %v", err)
	}
	waitRunStatus(t, pool, sandboxRunID, "succeeded", 0)
	_ = pool.QueryRow(ctx, `SELECT total_recovered FROM recovery_impact_rollups WHERE org_id = $1`, org).Scan(&total)
	if total != 1 {
		t.Fatalf("sandbox must never inflate the rollup: %d", total)
	}
}

// The incident closes ONLY with terminal success, atomically with the
// impact fact — and the metric now reads the durable facts.
func TestRecoveryItemAttribution(t *testing.T) {
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
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()
	org := fmt.Sprintf("org-attrib-%d", time.Now().UnixNano())

	var healed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healed.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	wf := &domain.Workflow{
		ID: "wf-attrib", Name: "Attrib", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "call", Type: "http", Config: map[string]any{
			"url": upstream.URL, "timeoutMs": 500,
		}}},
		Edges: []domain.Edge{},
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitRunStatus(t, pool, runID, "failed", 0)
	var deadLetterID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID)

	// 1. The redrive OPENS the incident (idempotent) but resolves nothing.
	if err := eng.RedriveDeadLetter(ctx, org, deadLetterID); err != nil {
		t.Fatalf("redrive: %v", err)
	}
	var itemStatus string
	_ = pool.QueryRow(ctx, `SELECT status FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`, org, deadLetterID).Scan(&itemStatus)
	if itemStatus != "open" {
		t.Fatalf("initiation must open, not resolve: %q", itemStatus)
	}
	waitRunStatus(t, pool, runID, "failed", 0)
	_ = pool.QueryRow(ctx, `SELECT status FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`, org, deadLetterID).Scan(&itemStatus)
	if itemStatus != "open" {
		t.Fatalf("a failed replay must keep the incident open: %q", itemStatus)
	}

	// 2. Heal + redrive the NEW dead letter: its incident opens and then
	// resolves atomically with the terminal success, audited.
	var secondDL string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1 AND status = 'open'
		ORDER BY created_at DESC LIMIT 1`, runID).Scan(&secondDL)
	healed.Store(true)
	if err := eng.RedriveDeadLetter(ctx, org, secondDL); err != nil {
		t.Fatalf("redrive 2: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	var resolvedStatus, reason string
	var firstAction *time.Time
	_ = pool.QueryRow(ctx, `SELECT status, COALESCE(resolution_reason,''), first_action_at
		FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`, org, secondDL).
		Scan(&resolvedStatus, &reason, &firstAction)
	if resolvedStatus != "resolved" || reason != "sandbox_replay_succeeded" || firstAction == nil {
		t.Fatalf("terminal success must resolve the incident: %s/%s/%v", resolvedStatus, reason, firstAction)
	}
	var resolvedAudits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'recovery.item.resolved'`, org).Scan(&resolvedAudits)
	if resolvedAudits != 1 {
		t.Fatalf("resolution audit: %d", resolvedAudits)
	}

	// 3. The metric reads the durable facts: one sample, positive p50.
	var sample int
	var p50 float64
	_ = pool.QueryRow(ctx, `WITH recovered AS (
		SELECT ie.downtime_ended_ms::float8 AS duration_ms
		FROM recovery_impact_events ie
		JOIN runs r ON r.id = ie.run_id AND r.org_id = ie.org_id
		WHERE ie.org_id = $1 AND r.replay_mode IS NULL)
		SELECT count(*)::int, COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), -1)::float8 FROM recovered`, org).
		Scan(&sample, &p50)
	if sample != 1 || p50 <= 0 {
		t.Fatalf("metric over durable facts: %d/%f", sample, p50)
	}
}
