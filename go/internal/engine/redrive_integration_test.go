//go:build integration

package engine

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/domain"
)

// F04→F05 shape: a permanent failure dead-letters the run; a redrive with
// the upstream healthy again revives it to success — the recovery wedge in
// miniature.

func TestRedriveRevivesRunToSuccess(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"id":"wf-redrive","nodes":[
		{"id":"fragile","type":"noop","config":{}},
		{"id":"after","type":"noop","config":{}}
	],"edges":[{"from":"fragile","to":"after"}]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	// Phase one: the upstream is down — the node fails terminally.
	var healthy atomic.Bool
	var fragileRuns atomic.Int32
	exec := func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow, _ map[string]any) (any, error) {
		if claim.RunID != runID {
			return nil, nil
		}
		if claim.NodeID == "fragile" {
			fragileRuns.Add(1)
			if !healthy.Load() {
				return nil, fmt.Errorf("upstream is down")
			}
		}
		return map[string]any{"ok": true}, nil
	}
	workerCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan struct{})
	go func() { defer close(done); _ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, exec, quietLogger()) }()
	waitRun(t, pool, runID, "failed", 15*time.Second)

	var deadLetterID string
	if err := pool.QueryRow(ctx, "select id from dead_letters where run_id=$1", runID).Scan(&deadLetterID); err != nil {
		t.Fatalf("dead letter expected: %v", err)
	}

	// Phase two: upstream healed; the operator redrives.
	healthy.Store(true)
	if err := eng.RedriveDeadLetter(ctx, org, deadLetterID); err != nil {
		t.Fatalf("redrive: %v", err)
	}
	waitRun(t, pool, runID, "succeeded", 15*time.Second)
	stop()
	<-done

	var status string
	var attempts int
	_ = pool.QueryRow(ctx, "select status, attempts from run_nodes where run_id=$1 and node_id='fragile'", runID).Scan(&status, &attempts)
	if status != "succeeded" || attempts != 2 {
		t.Fatalf("redriven node must succeed on the advanced attempt, got %s/%d", status, attempts)
	}
	if n := fragileRuns.Load(); n != 2 {
		t.Fatalf("expected exactly two executions of the fragile node, got %d", n)
	}
	var afterStatus string
	_ = pool.QueryRow(ctx, "select status from run_nodes where run_id=$1 and node_id='after'", runID).Scan(&afterStatus)
	if afterStatus != "succeeded" {
		t.Fatalf("downstream must complete after the revival, got %s", afterStatus)
	}
	var redriven int
	_ = pool.QueryRow(ctx, "select count(*) from run_events where run_id=$1 and type='node.redriven'", runID).Scan(&redriven)
	if redriven != 1 {
		t.Fatalf("expected one node.redriven event, got %d", redriven)
	}
}

func TestDoubleRedriveConflictsAndCrossOrgIsInvisible(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[{"id":"doomed","type":"noop","config":{}}],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	exec := func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow, _ map[string]any) (any, error) {
		if claim.RunID != runID {
			return nil, nil
		}
		return nil, errors.New("permanently down")
	}
	workerCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan struct{})
	go func() { defer close(done); _ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, exec, quietLogger()) }()
	waitRun(t, pool, runID, "failed", 15*time.Second)
	stop()
	<-done

	var deadLetterID string
	_ = pool.QueryRow(ctx, "select id from dead_letters where run_id=$1", runID).Scan(&deadLetterID)

	// Cross-org: the row simply does not exist for another tenant.
	if err := eng.RedriveDeadLetter(ctx, org+"-other", deadLetterID); !errors.Is(err, ErrDeadLetterNotFound) {
		t.Fatalf("cross-org redrive must be invisible, got %v", err)
	}
	if err := eng.RedriveDeadLetter(ctx, org, deadLetterID); err != nil {
		t.Fatalf("first redrive: %v", err)
	}
	if err := eng.RedriveDeadLetter(ctx, org, deadLetterID); !errors.Is(err, ErrRedriveConflict) {
		t.Fatalf("second redrive must conflict, got %v", err)
	}
}
