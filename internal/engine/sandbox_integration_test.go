//go:build integration

package engine

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

// The sandbox replay gate end to end: a validation run skips write-side
// http methods and write-side tools (the seeded effect NEVER fires),
// read sides still execute, and the run carries the static evidence
// level from birth. The same workflow in production mode fires the
// effect — proving the gate is the replay mode, not the workflow.
func TestSandboxReplayGate(t *testing.T) {
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
	org := fmt.Sprintf("org-sandbox-%d", time.Now().UnixNano())

	var writes atomic.Int64
	var reads atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			reads.Add(1)
		} else {
			writes.Add(1)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	wf := &domain.Workflow{
		ID: "wf-sandbox-gate", Name: "Gate", DSLVersion: "1.0",
		Nodes: []domain.Node{
			{ID: "read", Type: "http", Config: map[string]any{"url": upstream.URL, "method": "GET"}},
			{ID: "write", Type: "http", Config: map[string]any{"url": upstream.URL, "method": "POST"}},
		},
		Edges: []domain.Edge{{From: "read", To: "write"}},
	}

	// 1. Validation replay: read fires, write + email skip.
	runID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: wf, ReplayMode: "validation",
	})
	if err != nil {
		t.Fatalf("start validation: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	if reads.Load() != 1 || writes.Load() != 0 {
		t.Fatalf("validation must skip writes only: reads=%d writes=%d", reads.Load(), writes.Load())
	}
	var raw []byte
	_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'write'`, runID).Scan(&raw)
	if !strings.Contains(string(raw), `"skipped"`) || !strings.Contains(string(raw), "validation_dry_run") {
		t.Fatalf("write node must record the skip: %s", raw)
	}
	var evidenceLevel string
	_ = pool.QueryRow(ctx, `SELECT COALESCE(validation_evidence_level,'') FROM runs WHERE id = $1`, runID).Scan(&evidenceLevel)
	if evidenceLevel != "static" {
		t.Fatalf("validation run must be born with static evidence: %q", evidenceLevel)
	}

	// 2. The SAME workflow without replay mode fires the write for real.
	runID, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start production: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	if writes.Load() != 1 {
		t.Fatalf("production must fire the write: %d", writes.Load())
	}
	_ = pool.QueryRow(ctx, `SELECT COALESCE(validation_evidence_level,'') FROM runs WHERE id = $1`, runID).Scan(&evidenceLevel)
	if evidenceLevel != "" {
		t.Fatalf("production run carries no evidence level: %q", evidenceLevel)
	}
}
