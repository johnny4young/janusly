//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// claimOnErrorNode moves a queued node to running (the dispatcher's claim,
// minus the queue) and returns the claim handle for Complete/FailNode.
func claimOnErrorNode(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID, nodeID string) ClaimedNode {
	t.Helper()
	var rowID string
	if err := pool.QueryRow(ctx, `UPDATE run_nodes SET status = 'running', attempts = attempts + 1
		WHERE run_id = $1 AND node_id = $2 AND status = 'queued' RETURNING id`, runID, nodeID).Scan(&rowID); err != nil {
		t.Fatalf("claim %s: %v", nodeID, err)
	}
	return ClaimedNode{RowID: rowID, RunID: runID, NodeID: nodeID, Attempt: 1}
}

func onErrorNodeStatuses(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID string) map[string]string {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT node_id, status FROM run_nodes WHERE run_id = $1`, runID)
	if err != nil {
		t.Fatalf("read statuses: %v", err)
	}
	defer rows.Close()
	statuses := map[string]string{}
	for rows.Next() {
		var nodeID, status string
		if err := rows.Scan(&nodeID, &status); err != nil {
			t.Fatalf("scan: %v", err)
		}
		statuses[nodeID] = status
	}
	return statuses
}

// on-error edges: a terminal node failure with a declared error route is
// HANDLED — the run keeps going down the error branch, the success branch
// is skipped as "Branch not taken", no dead letter and no incident are
// produced, and the settled run reads succeeded with the handled count.
// Without the route, behavior is byte-identical to before: run failed +
// dead letter.
func TestOnErrorEdgeRoutesHandledFailures(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	doc := `{"id":"wf-onerror","dslVersion":"1.0","nodes":[
		{"id":"risky","type":"noop","config":{}},
		{"id":"celebrate","type":"noop","config":{}},
		{"id":"cleanup","type":"noop","config":{}}
	],"edges":[
		{"from":"risky","to":"celebrate"},
		{"from":"risky","to":"cleanup","onError":true}
	]}`
	wf := mustParse(t, doc)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start run: %v", err)
	}

	claim := claimOnErrorNode(t, ctx, pool, runID, "risky")
	if err := eng.FailNode(ctx, claim, errors.New("upstream exploded")); err != nil {
		t.Fatalf("fail node: %v", err)
	}

	// The run is still alive; the handler queued, the success branch skipped.
	var runStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&runStatus); err != nil {
		t.Fatalf("read run: %v", err)
	}
	if runStatus != "running" {
		t.Fatalf("handled failure must keep the run alive, got %q", runStatus)
	}
	statuses := onErrorNodeStatuses(t, ctx, pool, runID)
	if statuses["cleanup"] != "queued" {
		t.Fatalf("error branch must queue, got %q", statuses["cleanup"])
	}
	if statuses["celebrate"] != "skipped" {
		t.Fatalf("success branch must skip, got %q", statuses["celebrate"])
	}

	// No dead letter, no incident: the workflow recovers itself.
	var dlqCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM dead_letters WHERE run_id = $1`, runID).Scan(&dlqCount)
	if dlqCount != 0 {
		t.Fatalf("handled failure must not dead-letter, got %d", dlqCount)
	}

	// The handler completes → the run settles succeeded with the count.
	handlerClaim := claimOnErrorNode(t, ctx, pool, runID, "cleanup")
	if err := eng.CompleteNode(ctx, handlerClaim, map[string]any{"cleaned": true}); err != nil {
		t.Fatalf("complete handler: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&runStatus); err != nil {
		t.Fatalf("read run: %v", err)
	}
	if runStatus != "succeeded" {
		t.Fatalf("handled run must succeed, got %q", runStatus)
	}
	var payload []byte
	if err := pool.QueryRow(ctx, `SELECT payload FROM run_events
		WHERE run_id = $1 AND type = 'run.succeeded'`, runID).Scan(&payload); err != nil {
		t.Fatalf("read terminal event: %v", err)
	}
	var terminal struct {
		HandledFailures int `json:"handledFailures"`
	}
	_ = json.Unmarshal(payload, &terminal)
	if terminal.HandledFailures != 1 {
		t.Fatalf("terminal payload must count handled failures: %s", payload)
	}
}

// The inverse route: when the risky node SUCCEEDS, the error branch is
// skipped as "Branch not taken" and the success branch runs.
func TestOnErrorEdgeSkipsHandlerOnSuccess(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	doc := `{"id":"wf-onerror-ok","dslVersion":"1.0","nodes":[
		{"id":"risky","type":"noop","config":{}},
		{"id":"celebrate","type":"noop","config":{}},
		{"id":"cleanup","type":"noop","config":{}}
	],"edges":[
		{"from":"risky","to":"celebrate"},
		{"from":"risky","to":"cleanup","onError":true}
	]}`
	wf := mustParse(t, doc)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	claim := claimOnErrorNode(t, ctx, pool, runID, "risky")
	if err := eng.CompleteNode(ctx, claim, map[string]any{}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	statuses := onErrorNodeStatuses(t, ctx, pool, runID)
	if statuses["celebrate"] != "queued" || statuses["cleanup"] != "skipped" {
		t.Fatalf("success path must queue celebrate and skip cleanup: %+v", statuses)
	}
	var reason []byte
	if err := pool.QueryRow(ctx, `SELECT state_json FROM run_nodes
		WHERE run_id = $1 AND node_id = 'cleanup'`, runID).Scan(&reason); err != nil {
		t.Fatalf("read skip state: %v", err)
	}
	if string(reason) != `{"skipped": {"reason": "Branch not taken"}}` &&
		string(reason) != `{"skipped":{"reason":"Branch not taken"}}` {
		t.Fatalf("skip must carry the branch reason: %s", reason)
	}
}

// Failures without an error route keep today's exact posture.
func TestUnroutedFailureStillFailsTheRun(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	wf := mustParse(t, linearDoc)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	claim := claimOnErrorNode(t, ctx, pool, runID, "first")
	if err := eng.FailNode(ctx, claim, errors.New("boom")); err != nil {
		t.Fatalf("fail: %v", err)
	}
	var runStatus string
	var dlqCount int
	_ = pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&runStatus)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM dead_letters WHERE run_id = $1`, runID).Scan(&dlqCount)
	if runStatus != "failed" || dlqCount != 1 {
		t.Fatalf("unrouted failure must fail + dead-letter: %s / %d", runStatus, dlqCount)
	}
}
