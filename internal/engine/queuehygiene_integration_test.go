//go:build integration

package engine

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
)

// A failed run's queued siblings used to stay queued forever: never
// claimable (the claim joins running runs) but first in the FIFO claim
// index, so every claim walked past them. They now go back to pending and a
// redrive re-queues them through the ordinary readiness pass.
func TestFailedRunDemotesQueuedSiblingsAndRedriveRequeuesThem(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"id":"wf-hygiene","nodes":[
		{"id":"fragile","type":"noop","config":{}},
		{"id":"sibling","type":"noop","config":{}}
	],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	var healthy atomic.Bool
	exec := func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow, _ map[string]any) (any, error) {
		if claim.RunID != runID {
			return nil, nil
		}
		if claim.NodeID == "fragile" && !healthy.Load() {
			return nil, fmt.Errorf("upstream is down")
		}
		return map[string]any{"ok": true}, nil
	}
	// One worker: FIFO claims fragile first, so sibling is still queued when
	// the failure flips the run.
	workerCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan struct{})
	go func() { defer close(done); _ = eng.RunWorkers(workerCtx, 1, 30*time.Millisecond, exec, quietLogger()) }()
	waitRun(t, pool, runID, "failed", 15*time.Second)

	var queued int
	var siblingStatus string
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_nodes WHERE run_id = $1 AND status = 'queued'`, runID).Scan(&queued)
	_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id = $1 AND node_id = 'sibling'`, runID).Scan(&siblingStatus)
	if queued != 0 || siblingStatus != "pending" {
		t.Fatalf("a failed run must leave no queued rows: queued=%d sibling=%s", queued, siblingStatus)
	}

	var deadLetterID string
	if err := pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID); err != nil {
		t.Fatalf("dead letter: %v", err)
	}
	healthy.Store(true)
	if err := eng.RedriveDeadLetter(ctx, org, deadLetterID); err != nil {
		t.Fatalf("redrive: %v", err)
	}
	waitRun(t, pool, runID, "succeeded", 15*time.Second)
	_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id = $1 AND node_id = 'sibling'`, runID).Scan(&siblingStatus)
	if siblingStatus != "succeeded" {
		t.Fatalf("the redrive must bring the demoted sibling back through the readiness pass, got %s", siblingStatus)
	}
	stop()
	<-done
}
