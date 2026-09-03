//go:build integration

package engine

import (
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/grammar"
)

// Verification: NOTIFY — not the poll — drives dispatch. With a
// deliberately LONG poll (2s), a three-node chain finishing well under one
// poll interval proves every hop (start → claim, completion → readiness →
// claim) woke through LISTEN/NOTIFY. Poll-driven dispatch would need
// ≥2 poll ticks (~4s) for the chain.
func TestWakeLatencyIsNotifyDriven(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	const slowPoll = 2 * time.Second
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, slowPoll, dispatcher.Execute, quietLogger())
	}()
	t.Cleanup(func() { stopWorkers(); <-done })
	// Let the LISTEN connection establish before measuring.
	time.Sleep(300 * time.Millisecond)

	latencies := make([]time.Duration, 0, 5)
	for i := 0; i < 5; i++ {
		wf := mustParse(t, fmt.Sprintf(`{
			"id": "wake-%d", "name": "Wake", "dslVersion": "1.0",
			"nodes": [
				{"id": "a", "type": "noop", "config": {}},
				{"id": "b", "type": "noop", "config": {}},
				{"id": "c", "type": "noop", "config": {}}
			],
			"edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}]
		}`, i))
		startedAt := time.Now()
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		deadline := time.Now().Add(slowPoll * 3)
		for {
			var status string
			_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&status)
			if status == "succeeded" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("run %d never finished (status polling)", i)
			}
			time.Sleep(10 * time.Millisecond)
		}
		latencies = append(latencies, time.Since(startedAt))
	}
	sort.Slice(latencies, func(a, b int) bool { return latencies[a] < latencies[b] })
	median := latencies[len(latencies)/2]
	if median >= slowPoll {
		t.Fatalf("dispatch is poll-driven: median chain latency %v with poll %v (latencies %v)",
			median, slowPoll, latencies)
	}
	t.Logf("median 3-hop chain latency %v with poll %v (NOTIFY-driven)", median, slowPoll)
}
