package engine

import (
	"sync/atomic"
	"testing"
)

func TestWakeCountFromPayload(t *testing.T) {
	for payload, want := range map[string]int{"run-1:4": 4, "run-1": 1, "run-1:0": 1, "run-1:x": 1, "": 1} {
		if got := wakeCountFromPayload(payload); got != want {
			t.Fatalf("%q: got %d, want %d", payload, got, want)
		}
	}
}

func TestWakeFanoutSignalsAsManyWorkersAsNodesBecameReady(t *testing.T) {
	wakes := make([]chan struct{}, 4)
	idle := make([]atomic.Bool, 4)
	for i := range wakes {
		wakes[i] = make(chan struct{}, 1)
		idle[i].Store(true)
	}
	wake := newWakeFanout(wakes, idle)
	signalled := func() int {
		n := 0
		for _, ch := range wakes {
			if len(ch) > 0 {
				n++
			}
		}
		return n
	}
	wake(2)
	if got := signalled(); got != 2 {
		t.Fatalf("two ready nodes must wake two workers, got %d", got)
	}
	wake(1)
	if got := signalled(); got != 3 {
		t.Fatalf("the next wake must rotate to a worker not yet signalled, got %d", got)
	}
	wake(10)
	if got := signalled(); got != 4 {
		t.Fatalf("a wake never exceeds the pool, got %d", got)
	}
}

func TestWakeFanoutPrefersIdleWorkers(t *testing.T) {
	wakes := make([]chan struct{}, 3)
	idle := make([]atomic.Bool, 3)
	for i := range wakes {
		wakes[i] = make(chan struct{}, 1)
	}
	// Worker 0 (the rotation's starting point) is busy inside an executor;
	// one ready node must reach an idle sibling, not wait for it.
	idle[1].Store(true)
	idle[2].Store(true)
	wake := newWakeFanout(wakes, idle)
	wake(1)
	if len(wakes[0]) != 0 || len(wakes[1]) != 1 {
		t.Fatalf("the idle worker must be signalled first: %d %d %d", len(wakes[0]), len(wakes[1]), len(wakes[2]))
	}
	// With every worker busy the token still lands, to be consumed when the
	// executor returns.
	idle[1].Store(false)
	idle[2].Store(false)
	<-wakes[1]
	wake(1)
	if len(wakes[0])+len(wakes[1])+len(wakes[2]) != 1 {
		t.Fatal("a wake with no idle worker must still hand one token to a busy worker")
	}
}
