package httpapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testFeedbackMemoryPool(t *testing.T, workers, capacity int, timeout time.Duration, logger *slog.Logger) *feedbackMemoryPool {
	t.Helper()
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	pool, err := newFeedbackMemoryPool(feedbackMemoryPoolOptions{
		workers: workers, queueCapacity: capacity, taskTimeout: timeout, logger: logger,
	})
	if err != nil {
		t.Fatalf("new feedback memory pool: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := pool.shutdown(ctx); err != nil {
			t.Errorf("shutdown feedback memory pool: %v", err)
		}
	})
	return pool
}

func waitFeedbackPool(t *testing.T, pool *feedbackMemoryPool, predicate func(feedbackMemoryPoolSnapshot) bool) feedbackMemoryPoolSnapshot {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		snapshot := pool.snapshot()
		if predicate(snapshot) {
			return snapshot
		}
		time.Sleep(time.Millisecond)
	}
	snapshot := pool.snapshot()
	t.Fatalf("feedback memory pool condition not met: %+v", snapshot)
	return feedbackMemoryPoolSnapshot{}
}

func TestFeedbackMemoryPoolBoundsConcurrency(t *testing.T) {
	pool := testFeedbackMemoryPool(t, 3, 16, 2*time.Second, nil)
	gate := make(chan struct{})
	var current atomic.Int64
	var maximum atomic.Int64
	var completed atomic.Int64
	for range 9 {
		if !pool.enqueue(func(context.Context) error {
			active := current.Add(1)
			for observed := maximum.Load(); active > observed && !maximum.CompareAndSwap(observed, active); {
				observed = maximum.Load()
			}
			<-gate
			current.Add(-1)
			completed.Add(1)
			return nil
		}) {
			t.Fatal("bounded test task was unexpectedly dropped")
		}
	}
	// The pool marks a task active immediately before entering the task
	// closure. Wait for all closures to cross their own barrier as well, or a
	// fast scheduler can release the gate before concurrency is observable.
	waitFeedbackPool(t, pool, func(snapshot feedbackMemoryPoolSnapshot) bool {
		return snapshot.active == 3 && current.Load() == 3
	})
	close(gate)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := pool.shutdown(ctx); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if maximum.Load() != 3 || completed.Load() != 9 {
		t.Fatalf("pool escaped its bound: max=%d completed=%d", maximum.Load(), completed.Load())
	}
	if snapshot := pool.snapshot(); snapshot.accepted != 9 || snapshot.active != 0 || snapshot.depth != 0 || snapshot.failed != 0 {
		t.Fatalf("unexpected final snapshot: %+v", snapshot)
	}
}

func TestFeedbackMemoryPoolDropsSaturationWithoutBlocking(t *testing.T) {
	pool := testFeedbackMemoryPool(t, 1, 1, 2*time.Second, nil)
	release := make(chan struct{})
	if !pool.enqueue(func(context.Context) error { <-release; return nil }) {
		t.Fatal("first task was not accepted")
	}
	waitFeedbackPool(t, pool, func(snapshot feedbackMemoryPoolSnapshot) bool { return snapshot.active == 1 })
	if !pool.enqueue(func(context.Context) error { return nil }) {
		t.Fatal("queued task was not accepted")
	}
	waitFeedbackPool(t, pool, func(snapshot feedbackMemoryPoolSnapshot) bool { return snapshot.depth == 1 })
	started := time.Now()
	if pool.enqueue(func(context.Context) error { return nil }) {
		t.Fatal("saturated queue accepted another task")
	}
	if time.Since(started) > 100*time.Millisecond {
		t.Fatal("saturation path blocked the caller")
	}
	close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := pool.shutdown(ctx); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if snapshot := pool.snapshot(); snapshot.accepted != 2 || snapshot.dropped != 1 || snapshot.failed != 0 {
		t.Fatalf("unexpected overload snapshot: %+v", snapshot)
	}
}

func TestFeedbackMemoryPoolTimesOutTask(t *testing.T) {
	pool := testFeedbackMemoryPool(t, 1, 1, time.Second, nil)
	if !pool.enqueue(func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}) {
		t.Fatal("timeout task was not accepted")
	}
	waitFeedbackPool(t, pool, func(snapshot feedbackMemoryPoolSnapshot) bool {
		return snapshot.failed == 1 && snapshot.active == 0
	})
	if snapshot := pool.snapshot(); snapshot.accepted != 1 || snapshot.failed != 1 || snapshot.dropped != 0 {
		t.Fatalf("unexpected timeout snapshot: %+v", snapshot)
	}
}

func TestFeedbackMemoryPoolCancelsAndDropsWhenShutdownDeadlineExpires(t *testing.T) {
	pool := testFeedbackMemoryPool(t, 1, 1, 5*time.Second, nil)
	started := make(chan struct{})
	if !pool.enqueue(func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}) {
		t.Fatal("active task was not accepted")
	}
	<-started
	if !pool.enqueue(func(context.Context) error { return nil }) {
		t.Fatal("queued task was not accepted")
	}
	waitFeedbackPool(t, pool, func(snapshot feedbackMemoryPoolSnapshot) bool { return snapshot.depth == 1 })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := pool.shutdown(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown must surface its deadline, got %v", err)
	}
	if pool.enqueue(func(context.Context) error { return nil }) {
		t.Fatal("closed intake accepted new work")
	}
	if snapshot := pool.snapshot(); snapshot.accepted != 2 || snapshot.failed != 1 ||
		snapshot.dropped != 2 || snapshot.active != 0 || snapshot.depth != 0 {
		t.Fatalf("unexpected forced-shutdown snapshot: %+v", snapshot)
	}
}

func TestFeedbackMemoryPoolRecoversPanicWithoutLoggingValue(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	pool := testFeedbackMemoryPool(t, 1, 2, 2*time.Second, logger)
	const secret = "operator-token-super-secret"
	if !pool.enqueue(func(context.Context) error { panic(secret) }) {
		t.Fatal("panic task was not accepted")
	}
	nextRan := make(chan struct{})
	if !pool.enqueue(func(context.Context) error { close(nextRan); return nil }) {
		t.Fatal("post-panic task was not accepted")
	}
	select {
	case <-nextRan:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not continue after panic")
	}
	waitFeedbackPool(t, pool, func(snapshot feedbackMemoryPoolSnapshot) bool {
		return snapshot.failed == 1 && snapshot.active == 0
	})
	if strings.Contains(logs.String(), secret) {
		t.Fatalf("panic value leaked to logs: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "reason=panic") {
		t.Fatalf("panic reason missing from generic log: %s", logs.String())
	}
}

func TestFeedbackMemoryPoolDoesNotLogTaskError(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	pool := testFeedbackMemoryPool(t, 1, 1, 2*time.Second, logger)
	const secret = "provider-response-super-secret"
	if !pool.enqueue(func(context.Context) error { return errors.New(secret) }) {
		t.Fatal("failing task was not accepted")
	}
	waitFeedbackPool(t, pool, func(snapshot feedbackMemoryPoolSnapshot) bool {
		return snapshot.failed == 1 && snapshot.active == 0
	})
	if strings.Contains(logs.String(), secret) || !strings.Contains(logs.String(), "reason=task") {
		t.Fatalf("task error log was not generic: %s", logs.String())
	}
}

func TestFeedbackMemoryPoolRejectsUnsafeBounds(t *testing.T) {
	for _, options := range []feedbackMemoryPoolOptions{
		{workers: 0, queueCapacity: 1, taskTimeout: time.Second},
		{workers: 1, queueCapacity: 0, taskTimeout: time.Second},
		{workers: 1, queueCapacity: 1, taskTimeout: time.Millisecond},
		{workers: 33, queueCapacity: 4097, taskTimeout: 6 * time.Minute},
	} {
		pool, err := newFeedbackMemoryPool(options)
		if err == nil || pool != nil {
			t.Fatalf("unsafe options accepted: %+v", options)
		}
	}
}
