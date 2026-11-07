//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/store"
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

// The API's status pre-read happens outside the completion lock, so a
// completion can commit in between; the losing cancel must report the
// conflict instead of regressing a terminal run to cancelled.
func TestCancelRefusesTerminalRuns(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := pool.Exec(ctx, "update runs set status='succeeded' where id=$1", runID); err != nil {
		t.Fatalf("force terminal: %v", err)
	}
	if err := eng.CancelRun(ctx, runID, nil); !errors.Is(err, ErrRunAlreadyTerminal) {
		t.Fatalf("cancel of a terminal run must report the conflict, got: %v", err)
	}
	var status string
	var events int
	_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&status)
	_ = pool.QueryRow(ctx, "select count(*) from run_events where run_id=$1 and type='run.cancelled'", runID).Scan(&events)
	if status != "succeeded" || events != 0 {
		t.Fatalf("terminal run must stay intact: status=%s cancelEvents=%d", status, events)
	}
}

// Cancelling a subworkflow child is a terminal transition like any other:
// the cancellation write itself must arm the durable parent-notification
// marker so the reconciler settles the waiting parent instead of orphaning
// it. Asserted at the store layer — the engine's immediate delivery is
// orphan-tolerant and clears the marker when the parent is gone, which is
// exactly what the existing subworkflow tests cover.
func TestCancelWriteArmsParentNotificationForChildren(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := pool.Exec(ctx, `update runs
		set parent_run_id='parent-run', parent_node_id='call', parent_link_kind='subworkflow'
		where id=$1`, runID); err != nil {
		t.Fatalf("link parent: %v", err)
	}
	cancelled, err := store.New(pool).CancelRun(ctx, runID)
	if err != nil || cancelled != 1 {
		t.Fatalf("cancel write: rows=%d err=%v", cancelled, err)
	}
	var armed bool
	_ = pool.QueryRow(ctx,
		"select parent_notification_after is not null from runs where id=$1", runID).Scan(&armed)
	if !armed {
		t.Fatal("the cancellation write must arm parent_notification_after for a subworkflow child")
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

// Cancel appends run.cancelled after its semantic-case locks, so a cancel
// waiting on a case never holds the run's event sequence row.
func TestCancelDoesNotHoldEventSequenceWhileWaitingOnCases(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	caseID := "case-cancel-" + runID
	if _, err := pool.Exec(ctx, `
		INSERT INTO recovery_cases (id, org_id, run_id, workflow_version_id, source, detector_id,
			source_node_id, detector_kind, action, message, state)
		SELECT $1, org_id, id, workflow_version_id, 'semantic_violation', 'detector', 'first',
			'schema', 'observe', 'monitoring', 'monitoring'
		FROM runs WHERE id = $2`, caseID, runID); err != nil {
		t.Fatalf("seed case: %v", err)
	}
	locker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = locker.Rollback(ctx) }()
	var lockerPID uint32
	if err := locker.QueryRow(ctx, `SELECT pg_backend_pid() FROM recovery_cases WHERE id = $1 FOR UPDATE`, caseID).Scan(&lockerPID); err != nil {
		t.Fatalf("lock case: %v", err)
	}

	cancelled := make(chan error, 1)
	go func() { cancelled <- eng.CancelRun(ctx, runID, nil) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))`, int32(lockerPID)).Scan(&waiting); err != nil {
			t.Fatalf("inspect waiters: %v", err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancel never waited on the case lock")
		}
		time.Sleep(20 * time.Millisecond)
	}

	insertCtx, cancelInsert := context.WithTimeout(ctx, 3*time.Second)
	defer cancelInsert()
	at := time.Now()
	if err := store.New(pool).InsertRunEventAt(insertCtx, store.InsertRunEventAtParams{
		ID: newEventID(), RunID: runID, OrgID: org, Type: "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at,
	}); err != nil {
		t.Fatalf("an event insert must not wait for a cancel blocked on a case lock: %v", err)
	}

	if _, err := locker.Exec(ctx, `UPDATE recovery_cases SET state = 'abandoned' WHERE id = $1`, caseID); err != nil {
		t.Fatalf("release case: %v", err)
	}
	if err := locker.Commit(ctx); err != nil {
		t.Fatalf("commit locker: %v", err)
	}
	if err := <-cancelled; err != nil {
		t.Fatalf("cancel: %v", err)
	}
	var terminal int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1 AND type = 'run.cancelled'`, runID).Scan(&terminal); err != nil || terminal != 1 {
		t.Fatalf("run.cancelled events = %d, err %v", terminal, err)
	}
}
