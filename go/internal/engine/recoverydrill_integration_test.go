//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/store"
)

const runtimeDrillWorkflow = `{
	"id":"incident-triage","name":"Incident triage","templatePolicy":"strict",
	"nodes":[
		{"id":"trigger","type":"noop","config":{}},
		{"id":"classify","type":"noop","config":{}},
		{"id":"open_issue","type":"tool","config":{"tool":"github.create_issue","input":{}}},
		{"id":"page_oncall","type":"noop","config":{}}
	],
	"edges":[
		{"from":"trigger","to":"classify"},
		{"from":"classify","to":"open_issue"},
		{"from":"open_issue","to":"page_oncall"}
	]
}`

func TestRuntimeFailureDrillCrossesWorkerDLQBoundary(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, cancelWorkers := context.WithCancel(context.Background())
	workersDone := make(chan struct{})
	go func() {
		defer close(workersDone)
		_ = eng.RunWorkers(workerCtx, 1, 20*time.Millisecond, dispatcher.Execute, quietLogger())
	}()
	t.Cleanup(func() {
		cancelWorkers()
		<-workersDone
	})

	source := RecoveryDrillSource{
		Kind: "solution_pack_drill", PackID: "incident-triage",
		FixtureID: "github_secret_unbound", FailureMode: "credential_unavailable",
		RecoveryPath: "runtime_failure",
	}
	result, err := eng.RunRuntimeFailureDrill(ctx, RecoveryDrillInput{
		OrgID: org, CreatedBy: "operator", Workflow: mustParse(t, runtimeDrillWorkflow),
		FailedNodeID: "open_issue", Input: map[string]any{"event": map[string]any{"id": "sample"}},
		Source: source,
	})
	if err != nil {
		t.Fatalf("runtime drill: %v", err)
	}
	if result.DeadLetterID == "" || result.Evidence.ExecutedNodeID != "open_issue" ||
		result.Evidence.SeededAncestorCount != 2 || result.Evidence.Attempts != 1 {
		t.Fatalf("runtime evidence: %+v", result)
	}

	q := store.New(pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: result.RunID, OrgID: org})
	if err != nil || run.Status != "failed" || !run.ReplayMode.Valid ||
		run.ReplayMode.String != "validation" || !run.ValidationEvidenceLevel.Valid ||
		run.ValidationEvidenceLevel.String != "static" {
		t.Fatalf("validation run shape: %+v err=%v", run, err)
	}
	var inputEnvelope struct {
		Drill RecoveryDrillSource `json:"drill"`
	}
	if json.Unmarshal(run.InputJson, &inputEnvelope) != nil || inputEnvelope.Drill != source {
		t.Fatalf("drill provenance missing: %s", run.InputJson)
	}
	nodes, _ := q.ListRunNodesByRun(ctx, result.RunID)
	statuses := map[string]string{}
	for _, node := range nodes {
		statuses[node.NodeID] = node.Status
	}
	if statuses["trigger"] != "succeeded" || statuses["classify"] != "succeeded" ||
		statuses["open_issue"] != "failed" || statuses["page_oncall"] != "pending" {
		t.Fatalf("seeded runtime states: %+v", statuses)
	}
	letter, err := q.GetDeadLetter(ctx, store.GetDeadLetterParams{ID: result.DeadLetterID, OrgID: org})
	if err != nil || letter.NodeID != "open_issue" || letter.Attempt != 1 {
		t.Fatalf("exact runtime dead letter: %+v err=%v", letter, err)
	}
}

func TestStalledNodeDrillUsesExactScopedReaper(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	t.Setenv("JANUSLY_GO_REAPER_THRESHOLD_MS", "900000")
	workflow := mustParse(t, `{
		"id":"incident-triage","nodes":[
			{"id":"trigger","type":"noop","config":{}},
			{"id":"page_oncall","type":"tool","config":{"tool":"slack.post","input":{}}}
		],"edges":[{"from":"trigger","to":"page_oncall"}]
	}`)

	unrelatedRun, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("seed unrelated run: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE run_nodes SET status='running', started_at=now()-interval '2 hours'
		WHERE run_id=$1 AND node_id='first'`, unrelatedRun); err != nil {
		t.Fatalf("age unrelated node: %v", err)
	}

	source := RecoveryDrillSource{
		Kind: "solution_pack_drill", PackID: "incident-triage",
		FixtureID: "worker_interrupted_during_page", FailureMode: "worker_stalled",
		RecoveryPath: "stalled_node_reaper",
	}
	result, err := eng.RunStalledNodeDrill(ctx, RecoveryDrillInput{
		OrgID: org, CreatedBy: "operator", Workflow: workflow,
		FailedNodeID: "page_oncall", Source: source,
	})
	if err != nil {
		t.Fatalf("stalled drill: %v", err)
	}
	if result.Evidence.ThresholdMinutes != 15 || result.Evidence.Scanned != 1 ||
		result.Evidence.Reaped != 1 || result.Evidence.DeadLettered != 1 {
		t.Fatalf("stalled evidence: %+v", result)
	}

	var unrelatedStatus string
	if err := pool.QueryRow(ctx, `
		SELECT status FROM run_nodes WHERE run_id=$1 AND node_id='first'`,
		unrelatedRun).Scan(&unrelatedStatus); err != nil || unrelatedStatus != "running" {
		t.Fatalf("scoped reaper touched unrelated work: status=%s err=%v", unrelatedStatus, err)
	}
	var unrelatedLetters int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM dead_letters WHERE run_id=$1`, unrelatedRun).Scan(&unrelatedLetters)
	if unrelatedLetters != 0 {
		t.Fatalf("unrelated run was dead-lettered: %d", unrelatedLetters)
	}

	q := store.New(pool)
	run, _ := q.GetRun(ctx, store.GetRunParams{ID: result.RunID, OrgID: org})
	node, _ := q.GetRunNode(ctx, store.GetRunNodeParams{RunID: result.RunID, NodeID: "page_oncall"})
	if run.Status != "failed" || node.Status != "failed" ||
		!json.Valid(node.ErrorJson) || string(node.ErrorJson) == "{}" {
		t.Fatalf("stalled terminal state: run=%+v node=%+v", run, node)
	}
	events, err := q.ListRunEvents(ctx, store.ListRunEventsParams{
		RunID: result.RunID, BeforeCreatedAt: time.Now().Add(time.Hour),
		BeforeID: "zzzz", PageLimit: 20,
	})
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	foundFailure := false
	for _, event := range events {
		if event.Type != "node.failed" {
			continue
		}
		var payload map[string]any
		_ = json.Unmarshal(event.Payload, &payload)
		drill, _ := payload["drill"].(map[string]any)
		if payload["reason"] == "worker_stalled" &&
			drill["fixtureId"] == "worker_interrupted_during_page" {
			foundFailure = true
		}
	}
	if !foundFailure {
		t.Fatalf("node.failed lacks scoped drill evidence: %+v", events)
	}
}
