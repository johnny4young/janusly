//go:build integration

package engine

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
)

const fanOutDoc = `{"nodes":[
	{"id":"r1","type":"noop","config":{}},
	{"id":"r2","type":"noop","config":{}},
	{"id":"r3","type":"noop","config":{}},
	{"id":"r4","type":"noop","config":{}}
],"edges":[]}`

// A single NOTIFY used to wake one worker: the other idle workers slept
// until their poll fallback, so four ready roots started one at a time,
// seconds apart under a slow poll. The wake is now broadcast.
func TestFanOutWakesEveryIdleWorker(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	const slowPoll = 2 * time.Second

	var mu sync.Mutex
	started := map[string]time.Time{}
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 4, slowPoll, func(_ context.Context, claim ClaimedNode, _ domain.Node, _ *domain.Workflow, _ map[string]any) (any, error) {
			mu.Lock()
			started[claim.NodeID] = time.Now()
			mu.Unlock()
			time.Sleep(300 * time.Millisecond)
			return nil, nil
		}, quietLogger())
	}()
	t.Cleanup(func() { stopWorkers(); <-done })
	// Let the LISTEN connection establish and the workers go idle.
	time.Sleep(400 * time.Millisecond)

	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, fanOutDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	deadline := time.Now().Add(slowPoll * 4)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&status)
		if status == "succeeded" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fan-out never completed")
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(started) != 4 {
		t.Fatalf("expected 4 roots to run, got %d", len(started))
	}
	first, last := time.Time{}, time.Time{}
	for _, at := range started {
		if first.IsZero() || at.Before(first) {
			first = at
		}
		if at.After(last) {
			last = at
		}
	}
	if skew := last.Sub(first); skew >= slowPoll/2 {
		t.Fatalf("roots started %v apart under a %v poll: the wake did not reach every idle worker", skew, slowPoll)
	}
	t.Logf("four roots started within %v of each other", last.Sub(first))
}
