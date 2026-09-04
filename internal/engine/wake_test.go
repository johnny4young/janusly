package engine

import "testing"

func TestWakeCountFromPayload(t *testing.T) {
	for payload, want := range map[string]int{"run-1:4": 4, "run-1": 1, "run-1:0": 1, "run-1:x": 1, "": 1} {
		if got := wakeCountFromPayload(payload); got != want {
			t.Fatalf("%q: got %d, want %d", payload, got, want)
		}
	}
}

func TestWakeFanoutSignalsAsManyWorkersAsNodesBecameReady(t *testing.T) {
	wakes := make([]chan struct{}, 4)
	for i := range wakes {
		wakes[i] = make(chan struct{}, 1)
	}
	wake := newWakeFanout(wakes)
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
