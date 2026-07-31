//go:build integration

package engine

import (
	"strings"
	"testing"
	"time"
)

// The reaper turns the invisible failure (a worker killed mid-execution)
// into the ordinary operator surface: node failed, dead letter, run failed.

func TestReaperFailsStalledNodeIntoDLQ(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// Simulate the death: claim the root (queued→running) and never finish;
	// age the started_at past the threshold.
	if _, err := pool.Exec(ctx, `update run_nodes set status='running',
		started_at = now() - interval '2 hours'
		where run_id=$1 and node_id='first'`, runID); err != nil {
		t.Fatalf("age node: %v", err)
	}

	reaped := eng.ReapStalledNodes(ctx, time.Hour, 50, quietLogger())
	if reaped < 1 {
		t.Fatalf("expected at least this node reaped, got %d", reaped)
	}

	var nodeStatus, runStatus string
	var errorJSON []byte
	_ = pool.QueryRow(ctx, "select status, error_json from run_nodes where run_id=$1 and node_id='first'", runID).Scan(&nodeStatus, &errorJSON)
	_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&runStatus)
	if nodeStatus != "failed" || runStatus != "failed" {
		t.Fatalf("reap must terminate node and run: %s/%s", nodeStatus, runStatus)
	}
	if string(errorJSON) == "" || !strings.Contains(string(errorJSON), "WORKER_STALLED") {
		t.Fatalf("stall identity must persist: %s", errorJSON)
	}
	var deadLetters int
	_ = pool.QueryRow(ctx, "select count(*) from dead_letters where run_id=$1", runID).Scan(&deadLetters)
	if deadLetters != 1 {
		t.Fatalf("the reap must dead-letter for operator replay, got %d", deadLetters)
	}

	// Idempotent: a second sweep finds nothing of this run.
	_ = eng.ReapStalledNodes(ctx, time.Hour, 50, quietLogger())
	var stillOne int
	_ = pool.QueryRow(ctx, "select count(*) from dead_letters where run_id=$1", runID).Scan(&stillOne)
	if stillOne != 1 {
		t.Fatalf("double reap must not double dead-letter: %d", stillOne)
	}
}

func TestReaperLeavesHealthyExecutionAlone(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// Fresh running node — under threshold, must be untouched.
	if _, err := pool.Exec(ctx, `update run_nodes set status='running', started_at=now()
		where run_id=$1 and node_id='first'`, runID); err != nil {
		t.Fatalf("promote: %v", err)
	}
	_ = eng.ReapStalledNodes(ctx, time.Hour, 50, quietLogger())
	var status string
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='first'", runID).Scan(&status)
	if status != "running" {
		t.Fatalf("healthy execution must survive the sweep, got %s", status)
	}
}
