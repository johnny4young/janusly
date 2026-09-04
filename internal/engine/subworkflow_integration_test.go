//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
)

func saveWorkflowVersion(t *testing.T, ctx context.Context, q *store.Queries, org, workflowID, doc string) string {
	t.Helper()
	if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{
		ID: workflowID, OrgID: org, Name: workflowID,
	}); err != nil {
		t.Fatalf("insert workflow: %v", err)
	}
	versionID := workflowID + "-v1"
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: org, WorkflowID: workflowID, Version: 1,
		DagJson: json.RawMessage(doc),
	}); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	return versionID
}

// The atomic subworkflow loop: the parent checkpoints running→waiting in
// the SAME transaction that creates the child; the child's terminal flip
// arms the durable handoff marker; the notifier resumes the parent with
// the child's outputs; a failed child fails the parent with the first
// child failure as diagnostic; depth breach fails fast; a validation
// parent propagates validation to the child.
func TestSubworkflowLifecycle(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	q := store.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())

	// Child: declared output projected from its input.
	childID := "wf-child-" + suffix
	childDoc := `{"id":"` + childID + `","name":"child","dslVersion":"1.0",
		"nodes":[{"id":"work","type":"transform","config":{"mapping":{"doubled":"{{context.input.total}}-done"}}}],
		"edges":[],
		"outputs":{"result":"{{context.work.output.doubled}}"}}`
	saveWorkflowVersion(t, ctx, q, org, childID, childDoc)

	parentDoc := `{"id":"wf-parent-` + suffix + `","name":"parent","dslVersion":"1.0",
		"nodes":[
			{"id":"call","type":"subworkflow","config":{"workflowId":"` + childID + `","input":{"total":"41"}}},
			{"id":"after","type":"transform","config":{"mapping":{"got":"{{context.call.output.result}}"}}}
		],
		"edges":[{"from":"call","to":"after"}]}`
	parentRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, parentDoc)})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, parentRunID, "succeeded")

	// The parent node completed with the child's declared outputs and the
	// downstream node consumed them.
	var callState, afterState string
	_ = pool.QueryRow(ctx, `SELECT state_json::text FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`, parentRunID).Scan(&callState)
	_ = pool.QueryRow(ctx, `SELECT state_json::text FROM run_nodes WHERE run_id = $1 AND node_id = 'after'`, parentRunID).Scan(&afterState)
	if !strings.Contains(callState, `"childRunId"`) || !strings.Contains(callState, "41-done") {
		t.Fatalf("parent call state: %s", callState)
	}
	if !strings.Contains(afterState, "41-done") {
		t.Fatalf("downstream must see the child output: %s", afterState)
	}
	// Child link + settled marker.
	var childRunID, linkKind string
	var marker *time.Time
	_ = pool.QueryRow(ctx,
		`SELECT id, parent_link_kind, parent_notification_after FROM runs WHERE parent_run_id = $1`,
		parentRunID).Scan(&childRunID, &linkKind, &marker)
	if linkKind != "subworkflow" || marker != nil {
		t.Fatalf("child link: kind=%s marker=%v", linkKind, marker)
	}
	// The atomic checkpoint left both parent events.
	for _, eventType := range []string{"subworkflow.started", "node.waiting", "subworkflow.completed"} {
		var count int
		_ = pool.QueryRow(ctx,
			`SELECT count(*) FROM run_events WHERE run_id = $1 AND type = $2`, parentRunID, eventType).Scan(&count)
		if count != 1 {
			t.Fatalf("parent event %s count: %d", eventType, count)
		}
	}

	// ── failing child fails the parent with the root diagnostic ────────
	badChildID := "wf-badchild-" + suffix
	badChildDoc := `{"id":"` + badChildID + `","name":"bad","dslVersion":"1.0",
		"nodes":[{"id":"boom","type":"condition","config":{"expression":"require('fs')"}}],"edges":[]}`
	saveWorkflowVersion(t, ctx, q, org, badChildID, badChildDoc)
	failingParentDoc := `{"id":"wf-parent-bad-` + suffix + `","name":"parent","dslVersion":"1.0",
		"nodes":[{"id":"call","type":"subworkflow","config":{"workflowId":"` + badChildID + `"}}],"edges":[]}`
	failingParentRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, failingParentDoc)})
	if err != nil {
		t.Fatalf("start failing parent: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, failingParentRunID, "failed")
	var callError string
	_ = pool.QueryRow(ctx, `SELECT error_json::text FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`, failingParentRunID).Scan(&callError)
	if !strings.Contains(callError, "SUBWORKFLOW_FAILED") || !strings.Contains(callError, "firstChildFailure") {
		t.Fatalf("parent failure diagnostic: %s", callError)
	}

	// ── depth guard fails fast ──────────────────────────────────────────
	selfID := "wf-self-" + suffix
	selfDoc := `{"id":"` + selfID + `","name":"self","dslVersion":"1.0",
		"nodes":[{"id":"again","type":"subworkflow","config":{"workflowId":"` + selfID + `"}}],"edges":[]}`
	saveWorkflowVersion(t, ctx, q, org, selfID, selfDoc)
	selfRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, selfDoc)})
	if err != nil {
		t.Fatalf("start recursive: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, selfRunID, "failed")
	var depthRuns int
	_ = pool.QueryRow(ctx, `
		WITH RECURSIVE chain AS (
			SELECT id FROM runs WHERE id = $1
			UNION ALL
			SELECT r.id FROM runs r JOIN chain c ON r.parent_run_id = c.id
		) SELECT count(*) FROM chain`, selfRunID).Scan(&depthRuns)
	if depthRuns > 6 {
		t.Fatalf("depth guard must stop the chain: %d runs", depthRuns)
	}

	// ── validation parent propagates validation to the child ────────────
	validationParentRunID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: mustParse(t, parentDoc), ReplayMode: "validation",
	})
	if err != nil {
		t.Fatalf("start validation parent: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, validationParentRunID, "succeeded")
	var childReplayMode string
	_ = pool.QueryRow(ctx,
		`SELECT coalesce(replay_mode, '') FROM runs WHERE parent_run_id = $1`,
		validationParentRunID).Scan(&childReplayMode)
	if childReplayMode != "validation" {
		t.Fatalf("child must inherit validation: %q", childReplayMode)
	}
}

// The leased reconciler repairs a crash window: a terminal child whose
// immediate notification never ran (marker still armed, parent still
// waiting) settles on the sweep.
func TestSubworkflowTerminalReconcilerRepairsCrashWindow(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	q := store.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())

	childID := "wf-rec-child-" + suffix
	childDoc := `{"id":"` + childID + `","name":"child","dslVersion":"1.0",
		"nodes":[{"id":"work","type":"noop","config":{}}],"edges":[]}`
	saveWorkflowVersion(t, ctx, q, org, childID, childDoc)

	// Parent with a manually-armed waiting checkpoint + a terminal child
	// whose marker is still set (as if the process died post-flip).
	parentDoc := `{"id":"wf-rec-parent-` + suffix + `","name":"parent","dslVersion":"1.0",
		"nodes":[{"id":"call","type":"subworkflow","config":{"workflowId":"` + childID + `"}}],"edges":[]}`
	parentRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, parentDoc)})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	// Let the parent spawn the child and pause.
	deadline := time.Now().Add(10 * time.Second)
	var childRunID string
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	go func() { _ = eng.RunWorkers(workerCtx, 2, 25*time.Millisecond, dispatcher.Execute, quietLogger()) }()
	for childRunID == "" && time.Now().Before(deadline) {
		_ = pool.QueryRow(ctx, `SELECT id FROM runs WHERE parent_run_id = $1`, parentRunID).Scan(&childRunID)
		time.Sleep(25 * time.Millisecond)
	}
	stop()
	if childRunID == "" {
		t.Fatal("child never spawned")
	}
	// Wait for the child to finish; then SIMULATE the crash window by
	// re-arming the marker and reopening the parent node if the immediate
	// notifier already settled it.
	waitDeadline := time.Now().Add(10 * time.Second)
	var childStatus string
	for time.Now().Before(waitDeadline) {
		_ = pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, childRunID).Scan(&childStatus)
		if childStatus == "succeeded" {
			break
		}
		workerCtx2, stop2 := context.WithCancel(context.Background())
		go func() { _ = eng.RunWorkers(workerCtx2, 2, 25*time.Millisecond, dispatcher.Execute, quietLogger()) }()
		time.Sleep(100 * time.Millisecond)
		stop2()
	}
	if childStatus != "succeeded" {
		t.Fatalf("child status: %s", childStatus)
	}
	// Force the crash-window shape: parent node back to waiting on this
	// exact child + armed marker + parent running.
	waitingState, _ := json.Marshal(map[string]any{"waiting": map[string]any{
		"kind": "subworkflow", "childRunId": childRunID,
	}})
	if _, err := pool.Exec(ctx,
		`UPDATE run_nodes SET status = 'waiting', state_json = $1, finished_at = NULL WHERE run_id = $2 AND node_id = 'call'`,
		waitingState, parentRunID); err != nil {
		t.Fatalf("rearm node: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET status = 'running', output_json = NULL WHERE id = $1`, parentRunID); err != nil {
		t.Fatalf("rearm parent: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE runs SET parent_notification_after = now() - interval '5 minutes' WHERE id = $1`, childRunID); err != nil {
		t.Fatalf("arm marker: %v", err)
	}

	scanned, repaired, _ := eng.ReconcileSubworkflowTerminals(ctx)
	if scanned < 1 || repaired < 1 {
		t.Fatalf("reconciler must repair: scanned=%d repaired=%d", scanned, repaired)
	}
	var parentStatus, callStatus string
	_ = pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, parentRunID).Scan(&parentStatus)
	_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`, parentRunID).Scan(&callStatus)
	if callStatus != "succeeded" || parentStatus != "succeeded" {
		t.Fatalf("repair outcome: node=%s run=%s", callStatus, parentStatus)
	}
	var marker pgtype.Timestamptz
	_ = pool.QueryRow(ctx, `SELECT parent_notification_after FROM runs WHERE id = $1`, childRunID).Scan(&marker)
	if marker.Valid {
		t.Fatal("settled marker must clear")
	}
}
