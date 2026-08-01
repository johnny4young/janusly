//go:build integration

package engine

import (
	"strings"
	"testing"
)

// for_each through the REAL dispatcher: a green batch completes with
// ordered per-item results, and a write-side failure-budget breach fails
// the node WITHOUT consuming its declared retry policy (writeSide blocks
// whole-node retries — duplicate external effects are worse than a manual
// replay).
func TestForEachLoopThroughDispatcher(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	greenDoc := `{"id":"wf-loop-green","name":"loop","dslVersion":"1.0","nodes":[
		{"id":"batch","type":"loop","config":{
			"mode":"for_each","tool":"text.uppercase","concurrency":3,
			"items":["ada","grace","edsger"],"input":{"value":"{{item}}"}}}
	],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, greenDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")
	var state string
	_ = pool.QueryRow(ctx, `SELECT state_json::text FROM run_nodes WHERE run_id = $1 AND node_id = 'batch'`, runID).Scan(&state)
	for _, expected := range []string{`"mode": "for_each"`, `"succeededCount": 3`, `"ADA"`, `"EDSGER"`} {
		if !strings.Contains(state, expected) {
			t.Fatalf("green loop state missing %s: %s", expected, state)
		}
	}

	// vector.upsert without memory consent answers {ok:false} per item —
	// a write-side breach. The declared retry policy MUST NOT fire.
	redDoc := `{"id":"wf-loop-red","name":"loop","dslVersion":"1.0","nodes":[
		{"id":"batch","type":"loop","config":{
			"mode":"for_each","tool":"vector.upsert",
			"items":["a","b"],"input":{"content":"{{item}}"},
			"retry":{"maxAttempts":3,"delayMs":10}}}
	],"edges":[]}`
	runID, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, redDoc)})
	if err != nil {
		t.Fatalf("start red: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "failed")
	var attempts int
	var errorJSON string
	_ = pool.QueryRow(ctx,
		`SELECT attempts, error_json::text FROM run_nodes WHERE run_id = $1 AND node_id = 'batch'`,
		runID).Scan(&attempts, &errorJSON)
	if attempts != 1 {
		t.Fatalf("writeSide breach must not retry: attempts=%d", attempts)
	}
	if !strings.Contains(errorJSON, "LOOP_FAILURE_BUDGET_EXCEEDED") || !strings.Contains(errorJSON, `"writeSide": true`) {
		t.Fatalf("error identity: %s", errorJSON)
	}
	var budgetEvents int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM run_events WHERE run_id = $1 AND type = 'loop.failure_budget.exceeded'`,
		runID).Scan(&budgetEvents)
	if budgetEvents != 1 {
		t.Fatalf("budget event count: %d", budgetEvents)
	}
}
