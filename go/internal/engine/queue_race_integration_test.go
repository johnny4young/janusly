//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/domain"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// execCounter records executions per node id; the atomic increment is the
// exactly-once probe under worker concurrency.
type execCounter struct {
	mu     sync.Mutex
	counts map[string]int
}

func newExecCounter() *execCounter {
	return &execCounter{counts: map[string]int{}}
}

func (c *execCounter) bump(nodeID string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counts[nodeID]++
	return c.counts[nodeID]
}

func (c *execCounter) snapshot() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]int, len(c.counts))
	for k, v := range c.counts {
		out[k] = v
	}
	return out
}

func TestEightWorkersExecuteFanOutExactlyOnce(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	// 50 nodes: one root fanning out to 48 parallel mids, all joining a sink.
	nodes := []string{`{"id":"root","type":"noop","config":{}}`}
	edges := []string{}
	for i := 0; i < 48; i++ {
		id := fmt.Sprintf("mid_%02d", i)
		nodes = append(nodes, fmt.Sprintf(`{"id":%q,"type":"noop","config":{}}`, id))
		edges = append(edges, fmt.Sprintf(`{"from":"root","to":%q}`, id))
		edges = append(edges, fmt.Sprintf(`{"from":%q,"to":"sink"}`, id))
	}
	nodes = append(nodes, `{"id":"sink","type":"noop","config":{}}`)
	doc := `{"id":"wf-fanout","nodes":[` + strings.Join(nodes, ",") + `],"edges":[` + strings.Join(edges, ",") + `]}`

	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	counter := newExecCounter()
	workerCtx, stopWorkers := context.WithCancel(ctx)
	defer stopWorkers()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 8, 100*time.Millisecond, func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow) (any, error) {
			// Claims are global by design; scope the probe to this run so
			// leftovers from other tests in the shared database don't count.
			if claim.RunID == runID {
				counter.bump(claim.NodeID)
			}
			return map[string]any{"ok": true}, nil
		}, quietLogger())
	}()

	deadline := time.Now().Add(30 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&status)
		if status == "succeeded" {
			break
		}
		if status == "failed" || time.Now().After(deadline) {
			t.Fatalf("run ended %q (or timed out) instead of succeeding", status)
		}
		time.Sleep(25 * time.Millisecond)
	}
	stopWorkers()
	<-done

	counts := counter.snapshot()
	if len(counts) != 50 {
		t.Fatalf("expected all 50 nodes executed, got %d", len(counts))
	}
	for nodeID, n := range counts {
		if n != 1 {
			t.Fatalf("node %s executed %d times — the claim must be exactly-once", nodeID, n)
		}
	}

	var open int
	_ = pool.QueryRow(ctx, "select count(*) from run_nodes where run_id=$1 and status <> 'succeeded'", runID).Scan(&open)
	if open != 0 {
		t.Fatalf("every node row must end succeeded, %d did not", open)
	}
	var payload []byte
	if err := pool.QueryRow(ctx, "select payload from run_events where run_id=$1 and type='run.succeeded'", runID).Scan(&payload); err != nil {
		t.Fatalf("exactly one run.succeeded event expected: %v", err)
	}
	var parsed map[string]float64
	_ = json.Unmarshal(payload, &parsed)
	if parsed["nodes"] != 50 {
		t.Fatalf("run.succeeded payload parity broken: %s", payload)
	}
}

func TestDiamondJoinRunsOnceAfterBothBranches(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, diamondDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	var mu sync.Mutex
	finishedAt := map[string]time.Time{}
	var joinStarted time.Time
	joinRuns := 0

	workerCtx, stopWorkers := context.WithCancel(ctx)
	defer stopWorkers()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 4, 100*time.Millisecond, func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow) (any, error) {
			if claim.RunID != runID {
				return nil, nil
			}
			switch claim.NodeID {
			case "left":
				time.Sleep(150 * time.Millisecond)
			case "right":
				time.Sleep(20 * time.Millisecond)
			case "join":
				mu.Lock()
				joinStarted = time.Now()
				joinRuns++
				mu.Unlock()
			}
			mu.Lock()
			finishedAt[claim.NodeID] = time.Now()
			mu.Unlock()
			return nil, nil
		}, quietLogger())
	}()

	deadline := time.Now().Add(20 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&status)
		if status == "succeeded" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("diamond never completed")
		}
		time.Sleep(25 * time.Millisecond)
	}
	stopWorkers()
	<-done

	mu.Lock()
	defer mu.Unlock()
	if joinRuns != 1 {
		t.Fatalf("join executed %d times, want exactly once", joinRuns)
	}
	if joinStarted.Before(finishedAt["left"]) || joinStarted.Before(finishedAt["right"]) {
		t.Fatalf("join started %v before both branches finished (left %v, right %v)",
			joinStarted, finishedAt["left"], finishedAt["right"])
	}
}

func TestShutdownDrainsClaimedWorkAndResumes(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	// A wide fan of slow nodes: with concurrency 2, cancellation lands while
	// some are claimed and others still queued.
	nodes := []string{`{"id":"root","type":"noop","config":{}}`}
	edges := []string{}
	for i := 0; i < 5; i++ {
		id := fmt.Sprintf("slow_%d", i)
		nodes = append(nodes, fmt.Sprintf(`{"id":%q,"type":"noop","config":{}}`, id))
		edges = append(edges, fmt.Sprintf(`{"from":"root","to":%q}`, id))
	}
	doc := `{"nodes":[` + strings.Join(nodes, ",") + `],"edges":[` + strings.Join(edges, ",") + `]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	counter := newExecCounter()
	slowExec := func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow) (any, error) {
		if claim.RunID != runID {
			return nil, nil
		}
		if n := counter.bump(claim.NodeID); n > 1 {
			return nil, fmt.Errorf("node %s executed %d times", claim.NodeID, n)
		}
		if strings.HasPrefix(claim.NodeID, "slow_") {
			time.Sleep(200 * time.Millisecond)
		}
		return nil, nil
	}

	firstCtx, cancelFirst := context.WithCancel(ctx)
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		_ = eng.RunWorkers(firstCtx, 2, 50*time.Millisecond, slowExec, quietLogger())
	}()
	// Give the pool time to finish the root and claim slow nodes, then pull
	// the plug mid-flight.
	time.Sleep(350 * time.Millisecond)
	cancelFirst()
	select {
	case <-firstDone:
	case <-time.After(5 * time.Second):
		t.Fatal("drain must return promptly after in-flight work finishes")
	}

	// Drain contract: nothing this process claimed is left running, and the
	// run is not finished (queued work remains for the next pool).
	var running, queuedRows int
	_ = pool.QueryRow(ctx, "select count(*) from run_nodes where run_id=$1 and status='running'", runID).Scan(&running)
	_ = pool.QueryRow(ctx, "select count(*) from run_nodes where run_id=$1 and status='queued'", runID).Scan(&queuedRows)
	if running != 0 {
		t.Fatalf("drain left %d rows in running", running)
	}
	if queuedRows == 0 {
		t.Fatal("test needs unclaimed work to prove the resume path; all nodes already ran")
	}
	var runStatus string
	_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&runStatus)
	if runStatus != "running" {
		t.Fatalf("run must still be open after a drain, got %s", runStatus)
	}

	// A fresh pool claims the remainder on its first pass — no NOTIFY needed.
	secondCtx, cancelSecond := context.WithCancel(ctx)
	defer cancelSecond()
	secondDone := make(chan struct{})
	go func() {
		defer close(secondDone)
		_ = eng.RunWorkers(secondCtx, 2, 50*time.Millisecond, slowExec, quietLogger())
	}()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&status)
		if status == "succeeded" {
			break
		}
		if status == "failed" || time.Now().After(deadline) {
			t.Fatalf("resume ended %q instead of succeeding", status)
		}
		time.Sleep(25 * time.Millisecond)
	}
	cancelSecond()
	<-secondDone

	for nodeID, n := range counter.snapshot() {
		if n != 1 {
			t.Fatalf("node %s executed %d times across drain+resume", nodeID, n)
		}
	}
}

func TestExecutorFailureFailsNodeAndRun(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	workerCtx, stopWorkers := context.WithCancel(ctx)
	defer stopWorkers()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, 50*time.Millisecond, func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow) (any, error) {
			if claim.RunID != runID {
				return nil, nil
			}
			return nil, errors.New("upstream exploded")
		}, quietLogger())
	}()

	deadline := time.Now().Add(15 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&status)
		if status == "failed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("run never failed")
		}
		time.Sleep(25 * time.Millisecond)
	}
	stopWorkers()
	<-done

	var nodeStatus string
	var errorJSON []byte
	if err := pool.QueryRow(ctx,
		"select status, error_json from run_nodes where run_id=$1 and node_id='first'", runID,
	).Scan(&nodeStatus, &errorJSON); err != nil {
		t.Fatalf("read failed node: %v", err)
	}
	if nodeStatus != "failed" || !strings.Contains(string(errorJSON), "upstream exploded") {
		t.Fatalf("node terminal state wrong: %s %s", nodeStatus, errorJSON)
	}

	var successorStatus string
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='second'", runID).Scan(&successorStatus)
	if successorStatus != "pending" {
		t.Fatalf("successor of a failed node must stay pending, got %s", successorStatus)
	}

	var payload []byte
	if err := pool.QueryRow(ctx, "select payload from run_events where run_id=$1 and type='run.failed'", runID).Scan(&payload); err != nil {
		t.Fatalf("run.failed event expected: %v", err)
	}
	if !strings.Contains(string(payload), `"failedNodes": 1`) && !strings.Contains(string(payload), `"failedNodes":1`) {
		t.Fatalf("run.failed payload parity broken: %s", payload)
	}

	// Keyset order parity: the aggregate run.failed must sort after its
	// causal node.failed under (created_at, id).
	var order string
	_ = pool.QueryRow(ctx, `select string_agg(type, '>' order by created_at, id)
		from run_events where run_id=$1 and type in ('node.failed','run.failed')`, runID).Scan(&order)
	if order != "node.failed>run.failed" {
		t.Fatalf("event keyset order wrong: %s", order)
	}
}
