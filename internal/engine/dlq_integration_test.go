//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
)

// The failure model end to end: retries requeue through the wake-up clock,
// exhaustion captures exactly one dead letter with the replay snapshots,
// and a delayed retry stays unclaimable until its backoff passes.

const retryDoc = `{"id":"wf-flaky","nodes":[
	{"id":"flaky","type":"noop","config":{
		"retry":{"maxAttempts":3,"delayMs":1},
		"apiKey":"sk-secret-in-config-123"
	}}
],"edges":[]}`

func TestFlakyNodeSucceedsOnThirdAttempt(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, retryDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	var executions atomic.Int32
	flaky := func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow, _ map[string]any) (any, error) {
		if claim.RunID != runID {
			return nil, nil
		}
		if n := executions.Add(1); n < 3 {
			return nil, fmt.Errorf("transient boom %d", n)
		}
		return map[string]any{"finally": true}, nil
	}

	workerCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan struct{})
	go func() { defer close(done); _ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, flaky, quietLogger()) }()
	waitRun(t, pool, runID, "succeeded", 20*time.Second)
	stop()
	<-done

	var status string
	var attempts int
	_ = pool.QueryRow(ctx, "select status, attempts from run_nodes where run_id=$1 and node_id='flaky'", runID).Scan(&status, &attempts)
	if status != "succeeded" || attempts != 3 {
		t.Fatalf("expected succeeded on attempt 3, got %s/%d", status, attempts)
	}

	// Two node.retry events carrying the ladder positions and the error.
	var retryPayloads []string
	rows, err := pool.Query(ctx, "select payload from run_events where run_id=$1 and type='node.retry' order by created_at", runID)
	if err != nil {
		t.Fatalf("read retries: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p []byte
		_ = rows.Scan(&p)
		retryPayloads = append(retryPayloads, string(p))
	}
	if len(retryPayloads) != 2 ||
		!strings.Contains(retryPayloads[0], `"attempt": 2`) ||
		!strings.Contains(retryPayloads[1], `"attempt": 3`) ||
		!strings.Contains(retryPayloads[0], "transient boom 1") {
		t.Fatalf("retry event ladder broken: %v", retryPayloads)
	}

	var deadLetters int
	_ = pool.QueryRow(ctx, "select count(*) from dead_letters where run_id=$1", runID).Scan(&deadLetters)
	if deadLetters != 0 {
		t.Fatalf("a recovered node must not dead-letter, got %d rows", deadLetters)
	}

	var pulls, successes, failures int
	var value, meanReward float64
	if err := pool.QueryRow(ctx, `SELECT pulls, value, mean_reward, success_count, failure_count
		FROM routing_stats WHERE org_id=$1 AND node_id='flaky'`, org).
		Scan(&pulls, &value, &meanReward, &successes, &failures); err != nil {
		t.Fatalf("routing outcome stats: %v", err)
	}
	if pulls != 3 || value != -1 || math.Abs(meanReward-(-1.0/3.0)) > 1e-6 || successes != 1 || failures != 2 {
		t.Fatalf("routing outcome stats = pulls=%d value=%v mean=%v successes=%d failures=%d",
			pulls, value, meanReward, successes, failures)
	}
}

func TestExhaustedRetriesCaptureExactlyOneDeadLetter(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"id":"wf-doomed","nodes":[
		{"id":"doomed","type":"noop","config":{
			"retry":{"maxAttempts":2,"delayMs":1},
			"authorization":"Bearer super-secret-token"
		}}
	],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	doomed := func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow, _ map[string]any) (any, error) {
		if claim.RunID != runID {
			return nil, nil
		}
		return nil, errors.New("permanent boom")
	}
	workerCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, doomed, quietLogger())
	}()
	waitRun(t, pool, runID, "failed", 20*time.Second)
	stop()
	<-done

	var count int
	_ = pool.QueryRow(ctx, "select count(*) from dead_letters where run_id=$1", runID).Scan(&count)
	if count != 1 {
		t.Fatalf("exactly one dead letter expected, got %d", count)
	}
	var orgID, nodeID, dlStatus string
	var attempt int
	var workflowJSON, nodeJSON, errorJSON []byte
	if err := pool.QueryRow(ctx, `select org_id, node_id, attempt, status, workflow_json, node_json, error_json
		from dead_letters where run_id=$1`, runID).Scan(&orgID, &nodeID, &attempt, &dlStatus, &workflowJSON, &nodeJSON, &errorJSON); err != nil {
		t.Fatalf("read dead letter: %v", err)
	}
	if orgID != org || nodeID != "doomed" || attempt != 2 || dlStatus != "open" {
		t.Fatalf("dead letter identity wrong: %s %s %d %s", orgID, nodeID, attempt, dlStatus)
	}
	var wfSnapshot map[string]any
	_ = json.Unmarshal(workflowJSON, &wfSnapshot)
	if wfSnapshot["id"] != "wf-doomed" {
		t.Fatalf("workflow snapshot must be the exact run workflow: %s", workflowJSON)
	}
	var nodeSnapshot map[string]any
	_ = json.Unmarshal(nodeJSON, &nodeSnapshot)
	if nodeSnapshot["id"] != "doomed" {
		t.Fatalf("node snapshot must be the failed node: %s", nodeJSON)
	}
	// Key redaction holds in BOTH snapshots — replay JSON never carries
	// secret-shaped values in the clear.
	if strings.Contains(string(workflowJSON), "super-secret-token") ||
		strings.Contains(string(nodeJSON), "super-secret-token") {
		t.Fatal("sensitive-shaped config values must be redacted in dead-letter snapshots")
	}
	if !strings.Contains(string(errorJSON), "permanent boom") {
		t.Fatalf("error snapshot must carry the terminal error: %s", errorJSON)
	}

	var nodeStatus string
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='doomed'", runID).Scan(&nodeStatus)
	if nodeStatus != "failed" {
		t.Fatalf("node must end failed, got %s", nodeStatus)
	}
	var failedPayload []byte
	_ = pool.QueryRow(ctx, "select payload from run_events where run_id=$1 and type='node.failed'", runID).Scan(&failedPayload)
	if !strings.Contains(string(failedPayload), `"attempt": 2`) {
		t.Fatalf("node.failed must carry the terminal attempt: %s", failedPayload)
	}
}

func TestDelayedRetryIsNotClaimableUntilDue(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[{"id":"slowretry","type":"noop","config":{
		"retry":{"maxAttempts":2,"delayMs":60000}
	}}],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	var executions atomic.Int32
	exec := func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow, _ map[string]any) (any, error) {
		if claim.RunID != runID {
			return nil, nil
		}
		if executions.Add(1) == 1 {
			return nil, errors.New("first try boom")
		}
		return map[string]any{"recovered": true}, nil
	}
	workerCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan struct{})
	go func() { defer close(done); _ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, exec, quietLogger()) }()

	// Wait until the retry is scheduled (node back to queued with the
	// future wake-up), then hold: the claim must NOT pick it up.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var status string
		var attempts int
		_ = pool.QueryRow(ctx, "select status, attempts from run_nodes where run_id=$1", runID).Scan(&status, &attempts)
		if status == "queued" && attempts == 2 {
			break
		}
		if time.Now().After(deadline) {
			// Diagnostic capture for the flake: the exact row state, how many
			// executions the stub saw, wake-up rows, and the claimable queue
			// ahead of this node.
			var wakeups int
			_ = pool.QueryRow(ctx, `select count(*) from run_wakeups w
				join run_nodes rn on rn.id = w.run_node_id where rn.run_id=$1`, runID).Scan(&wakeups)
			var queuedAhead int
			_ = pool.QueryRow(ctx, `select count(*) from run_nodes rn join runs r on r.id=rn.run_id
				where rn.status='queued' and r.status='running'`).Scan(&queuedAhead)
			t.Fatalf("retry never scheduled: node=%s/%d execs=%d wakeups=%d claimableGlobal=%d",
				status, attempts, executions.Load(), wakeups, queuedAhead)
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)
	if n := executions.Load(); n != 1 {
		t.Fatalf("delayed retry ran early: %d executions", n)
	}

	// Move the backoff clock: the wake-up becomes due and the poll cadence
	// claims it — no NOTIFY involved, no real 60s wait.
	if _, err := pool.Exec(ctx, `update run_wakeups set wake_at = now() - interval '1 second'
		where run_node_id = (select id from run_nodes where run_id=$1)`, runID); err != nil {
		t.Fatalf("advance clock: %v", err)
	}
	waitRun(t, pool, runID, "succeeded", 15*time.Second)
	stop()
	<-done

	if n := executions.Load(); n != 2 {
		t.Fatalf("expected exactly two executions across the retry, got %d", n)
	}
	var leftoverWakeups int
	_ = pool.QueryRow(ctx, `select count(*) from run_wakeups
		where run_node_id = (select id from run_nodes where run_id=$1)`, runID).Scan(&leftoverWakeups)
	if leftoverWakeups != 0 {
		t.Fatalf("consumed wake-ups must be swept, %d remain", leftoverWakeups)
	}
}

func waitRun(t *testing.T, pool *pgxpool.Pool, runID, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		var status string
		_ = pool.QueryRow(context.Background(), "select status from runs where id=$1", runID).Scan(&status)
		if status == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("run stuck at %q, want %s", status, want)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
