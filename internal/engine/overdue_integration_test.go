//go:build integration

package engine

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/grammar"
)

// Verification: the pilot's "overdue checkpoint" posture. The
// reference needs a dedicated overdue reconciler because BullMQ delayed
// jobs can be lost; the pilot's wake-up clock lives in Postgres, so a
// wakeup that came due while NO worker was polling simply fires on the
// next poll — the durable clock IS the reconciler. The stalled-node
// reaper covers the other crash class (a worker died mid-execution).
func TestOverdueTimerFiresAfterPollingGap(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	doc := `{"nodes":[
		{"id":"pause","type":"wait_until","config":{"duration":"PT1S"}},
		{"id":"after","type":"noop","config":{}}
	],"edges":[{"from":"pause","to":"after"}]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	// Phase 1: workers run just long enough to park the node waiting.
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	phase1, stop1 := context.WithCancel(context.Background())
	go func() { _ = eng.RunWorkers(phase1, 2, 25*time.Millisecond, dispatcher.Execute, quietLogger()) }()
	deadline := time.Now().Add(10 * time.Second)
	var nodeStatus string
	for time.Now().Before(deadline) {
		_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id = $1 AND node_id = 'pause'`, runID).Scan(&nodeStatus)
		if nodeStatus == "waiting" {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	stop1()
	if nodeStatus != "waiting" {
		t.Fatalf("node never parked: %s", nodeStatus)
	}

	// Phase 2: the wakeup comes due while NOBODY polls (the outage).
	time.Sleep(1200 * time.Millisecond)
	var overdue int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM go_pilot_wakeups w JOIN run_nodes n ON n.id = w.run_node_id
		 WHERE n.run_id = $1 AND w.wake_at <= now()`, runID).Scan(&overdue)
	if overdue != 1 {
		t.Fatalf("the due wakeup must survive the gap in Postgres: %d", overdue)
	}

	// Phase 3: polling resumes → the timer fires exactly once, no repair
	// pass needed.
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")
	var resumes int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM run_events WHERE run_id = $1 AND type = 'node.resumed'`, runID).Scan(&resumes)
	if resumes != 1 {
		t.Fatalf("exactly one resume: %d", resumes)
	}
}

// The reaper half: a node stuck `running` past the threshold (worker died
// mid-execution) is failed loudly rather than auto-re-executed.
func TestReaperReclaimsStalledRunningNode(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[{"id":"stuck","type":"noop","config":{}}],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// Simulate the dead worker: claim the node into `running` long ago.
	if _, err := pool.Exec(ctx,
		`UPDATE run_nodes SET status = 'running', started_at = now() - interval '30 minutes'
		 WHERE run_id = $1 AND node_id = 'stuck'`, runID); err != nil {
		t.Fatalf("simulate stall: %v", err)
	}
	// The shared dev DB may hold other stalled debris — assert OUR node
	// is among the reaped, not the exact count.
	if reaped := eng.ReapStalledNodes(ctx, 10*time.Minute, 50, slog.Default()); reaped < 1 {
		t.Fatalf("reaper must reclaim the stalled node: %d", reaped)
	}
	var nodeStatus, runStatus string
	_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id = $1 AND node_id = 'stuck'`, runID).Scan(&nodeStatus)
	_ = pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&runStatus)
	if nodeStatus != "failed" || runStatus != "failed" {
		t.Fatalf("stalled node must fail loudly: node=%s run=%s", nodeStatus, runStatus)
	}
}
