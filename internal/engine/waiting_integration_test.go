//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/grammar"
)

// The waiting lifecycle end to end: approval pauses and a resume completes
// exactly once; wait_until auto-completes through the wake-up clock.

func startPool(t *testing.T, eng *Engine) (stop func()) {
	t.Helper()
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, dispatcher.Execute, quietLogger())
	}()
	return func() { cancel(); <-done }
}

const approvalDoc = `{"nodes":[
	{"id":"gate","type":"approval","config":{"message":"Ship it?","assignee":"ops"}},
	{"id":"after","type":"transform","config":{"mapping":{"released":true}}}
],"edges":[{"from":"gate","to":"after"}]}`

func TestApprovalPausesAndResumeCompletesEndToEnd(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, approvalDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	stop := startPool(t, eng)
	defer stop()

	// The run pauses: node waiting, run still running, checkpoint persisted.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='gate'", runID).Scan(&status)
		if status == "waiting" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("approval never reached waiting")
		}
		time.Sleep(20 * time.Millisecond)
	}
	var runStatus string
	_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&runStatus)
	if runStatus != "running" {
		t.Fatalf("a paused run stays running, got %s", runStatus)
	}
	var state []byte
	_ = pool.QueryRow(ctx, "select state_json->'waiting' from run_nodes where run_id=$1 and node_id='gate'", runID).Scan(&state)
	var waiting map[string]any
	_ = json.Unmarshal(state, &waiting)
	if waiting["kind"] != "approval" || waiting["reason"] != "Waiting for human approval" ||
		waiting["title"] != "Ship it?" || waiting["assignee"] != "ops" ||
		waiting["resumeToken"] != runID+":gate" || waiting["waitingSince"] == nil {
		t.Fatalf("waiting checkpoint parity broken: %s", state)
	}
	var waitingEvents int
	_ = pool.QueryRow(ctx, "select count(*) from run_events where run_id=$1 and type='node.waiting'", runID).Scan(&waitingEvents)
	if waitingEvents != 1 {
		t.Fatalf("expected one node.waiting event, got %d", waitingEvents)
	}

	// Human decision: the resume completes the node with the reference's
	// historical EMPTY output and releases downstream work.
	if err := eng.ResumeRun(ctx, runID, "gate"); err != nil {
		t.Fatalf("resume: %v", err)
	}
	waitRun(t, pool, runID, "succeeded", 15*time.Second)

	var gateOutput []byte
	_ = pool.QueryRow(ctx, "select state_json->'output' from run_nodes where run_id=$1 and node_id='gate'", runID).Scan(&gateOutput)
	if strings.TrimSpace(string(gateOutput)) != "{}" {
		t.Fatalf("approval output must stay empty (decision lives in the timeline): %s", gateOutput)
	}
	var resumedEvents int
	_ = pool.QueryRow(ctx, "select count(*) from run_events where run_id=$1 and type='node.resumed'", runID).Scan(&resumedEvents)
	if resumedEvents != 1 {
		t.Fatalf("expected one node.resumed event, got %d", resumedEvents)
	}
}

func TestWebhookResumeCapturesPayloadEndToEnd(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[
		{"id":"trigger","type":"webhook","config":{}},
		{"id":"after","type":"transform","config":{"mapping":{"customer":"{{context.trigger.output.customer}}"}}}
	],"edges":[{"from":"trigger","to":"after"}]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	stop := startPool(t, eng)
	defer stop()

	deadline := time.Now().Add(10 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='trigger'", runID).Scan(&status)
		if status == "waiting" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("webhook never reached waiting")
		}
		time.Sleep(20 * time.Millisecond)
	}

	payload := map[string]any{"customer": "leah@example.com", "amountUsd": float64(49)}
	if err := eng.ResumeRunWithInput(ctx, runID, "trigger", payload, ""); err != nil {
		t.Fatalf("resume: %v", err)
	}
	waitRun(t, pool, runID, "succeeded", 15*time.Second)

	var output, eventPayload []byte
	_ = pool.QueryRow(ctx, "select state_json->'output' from run_nodes where run_id=$1 and node_id='trigger'", runID).Scan(&output)
	_ = pool.QueryRow(ctx, "select payload from run_events where run_id=$1 and node_id='trigger' and type='node.resumed'", runID).Scan(&eventPayload)
	var outputValue, eventValue map[string]any
	_ = json.Unmarshal(output, &outputValue)
	_ = json.Unmarshal(eventPayload, &eventValue)
	if outputValue["customer"] != "leah@example.com" || outputValue["amountUsd"] != float64(49) {
		t.Fatalf("webhook output: %s", output)
	}
	if eventOutput, ok := eventValue["output"].(map[string]any); !ok || eventOutput["customer"] != "leah@example.com" {
		t.Fatalf("webhook resume event: %s", eventPayload)
	}
	var downstream []byte
	_ = pool.QueryRow(ctx, "select state_json->'output' from run_nodes where run_id=$1 and node_id='after'", runID).Scan(&downstream)
	if !strings.Contains(string(downstream), "leah@example.com") {
		t.Fatalf("downstream did not receive webhook output: %s", downstream)
	}
}

func TestDoubleResumeConflicts(t *testing.T) {
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
			t.Fatal("approval never reached waiting")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := eng.ResumeRun(ctx, runID, "gate"); err != nil {
		t.Fatalf("first resume: %v", err)
	}
	if err := eng.ResumeRun(ctx, runID, "gate"); !errors.Is(err, ErrResumeConflict) {
		t.Fatalf("second resume must conflict, got %v", err)
	}
	if err := eng.ResumeRun(ctx, runID, "ghost"); !errors.Is(err, ErrResumeNodeNotFound) {
		t.Fatalf("unknown node must report not-found, got %v", err)
	}
}

func TestWaitUntilAutoCompletesThroughTheClock(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[
		{"id":"pause","type":"wait_until","config":{"duration":"PT0.4S"}},
		{"id":"after","type":"noop","config":{}}
	],"edges":[{"from":"pause","to":"after"}]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	stop := startPool(t, eng)
	defer stop()

	// Completes ALONE: no resume call anywhere — the wake-up clock fires it.
	waitRun(t, pool, runID, "succeeded", 20*time.Second)

	var state []byte
	_ = pool.QueryRow(ctx, `select payload->'metadata' from run_events
		where run_id=$1 and type='node.waiting'`, runID).Scan(&state)
	var metadata map[string]any
	_ = json.Unmarshal(state, &metadata)
	if metadata["kind"] != "timer" || metadata["source"] != "duration" ||
		metadata["durationMs"] != float64(400) || metadata["wakeAt"] == nil {
		t.Fatalf("timer metadata parity broken: %s", state)
	}
	var leftover int
	_ = pool.QueryRow(ctx, `select count(*) from go_pilot_wakeups w
		join run_nodes rn on rn.id = w.run_node_id where rn.run_id=$1`, runID).Scan(&leftover)
	if leftover != 0 {
		t.Fatalf("consumed timer wakeups must be gone, %d remain", leftover)
	}
	var resumed int
	_ = pool.QueryRow(ctx, "select count(*) from run_events where run_id=$1 and type='node.resumed'", runID).Scan(&resumed)
	if resumed != 1 {
		t.Fatalf("the timer firing must record node.resumed, got %d", resumed)
	}
}

func TestWaitUntilPastInstantResumesImmediately(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[{"id":"pause","type":"wait_until","config":{"until":"2020-01-01T00:00:00Z"}}],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	stop := startPool(t, eng)
	defer stop()
	waitRun(t, pool, runID, "succeeded", 15*time.Second)
}

func TestWaitUntilInvalidConfigFailsWithExactMessage(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[{"id":"pause","type":"wait_until","config":{
		"duration":"PT5S","until":"2030-01-01T00:00:00Z"
	}}],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	stop := startPool(t, eng)
	defer stop()
	waitRun(t, pool, runID, "failed", 15*time.Second)

	var errorJSON []byte
	_ = pool.QueryRow(ctx, "select error_json from run_nodes where run_id=$1 and node_id='pause'", runID).Scan(&errorJSON)
	if !strings.Contains(string(errorJSON), "wait_until accepts either config.duration or config.until, not both") {
		t.Fatalf("config error message parity broken: %s", errorJSON)
	}
}
