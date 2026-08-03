//go:build integration

package engine

import (
	"strings"
	"testing"
	"time"
)

// Cancellation semantics: cancellable nodes flip with the run, an executing
// node finishes naturally, and the post-success guard keeps a cancelled run
// from scheduling downstream work.

func TestCancelFlipsRunAndCancellableNodes(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, approvalDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	stop := startPool(t, eng)
	defer stop()

	deadline := time.Now().Add(10 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='gate'", runID).Scan(&status)
		if status == "waiting" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("gate never waited")
		}
		time.Sleep(20 * time.Millisecond)
	}

	if err := eng.CancelRun(ctx, runID, map[string]any{"by": "tester"}); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	var runStatus, gateStatus, afterStatus string
	var gateState []byte
	_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&runStatus)
	_ = pool.QueryRow(ctx, "select status, state_json from run_nodes where run_id=$1 and node_id='gate'", runID).Scan(&gateStatus, &gateState)
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='after'", runID).Scan(&afterStatus)
	if runStatus != "cancelled" || gateStatus != "cancelled" || afterStatus != "cancelled" {
		t.Fatalf("cancellable states must flip: run=%s gate=%s after=%s", runStatus, gateStatus, afterStatus)
	}
	if !strings.Contains(string(gateState), `"by": "tester"`) && !strings.Contains(string(gateState), `"by":"tester"`) {
		t.Fatalf("cancel reason must persist under state_json.cancelled: %s", gateState)
	}
	var events int
	_ = pool.QueryRow(ctx, "select count(*) from run_events where run_id=$1 and type='run.cancelled'", runID).Scan(&events)
	if events != 1 {
		t.Fatalf("expected one run.cancelled event, got %d", events)
	}

	// A resume after cancellation loses the CAS cleanly.
	if err := eng.ResumeRun(ctx, runID, "gate"); err == nil {
		t.Fatal("resume after cancel must conflict")
	}
}

func TestRunningNodeFinishesNaturallyAfterCancel(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// Claim the root manually (queued→running), cancel, then complete it.
	var rowID string
	if err := pool.QueryRow(ctx, `update run_nodes set status='running', started_at=now()
		where run_id=$1 and node_id='first' returning id`, runID).Scan(&rowID); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := eng.CancelRun(ctx, runID, nil); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	claim := ClaimedNode{RowID: rowID, RunID: runID, NodeID: "first", Attempt: 1}
	if err := eng.CompleteNode(ctx, claim, map[string]any{"late": true}); err != nil {
		t.Fatalf("late completion: %v", err)
	}

	var firstStatus, secondStatus, runStatus string
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='first'", runID).Scan(&firstStatus)
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='second'", runID).Scan(&secondStatus)
	_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&runStatus)
	if firstStatus != "succeeded" {
		t.Fatalf("running node must finish naturally, got %s", firstStatus)
	}
	if secondStatus != "cancelled" || runStatus != "cancelled" {
		t.Fatalf("cancelled run must not schedule downstream: second=%s run=%s", secondStatus, runStatus)
	}
}
