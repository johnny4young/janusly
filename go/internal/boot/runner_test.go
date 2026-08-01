package boot

import (
	"context"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

func quiet() *slog.Logger {
	return slog.New(slog.NewTextHandler(discard{}, &slog.HandlerOptions{Level: slog.LevelError + 4}))
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// A panicking sweep restarts (with backoff) instead of dying silently or
// killing the process — the T-512 acceptance.
func TestRunnerRestartsPanickingSweep(t *testing.T) {
	runner := NewRunner(context.Background(), quiet())
	var starts atomic.Int32
	runner.Go("bomb", func(ctx context.Context) {
		starts.Add(1)
		panic("boom")
	})
	deadline := time.Now().Add(5 * time.Second)
	for starts.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("panicking sweep never restarted: %d starts", starts.Load())
		}
		time.Sleep(20 * time.Millisecond)
	}
	runner.Shutdown()
}

// Shutdown cancels and WAITS: after it returns, no supervised goroutine
// is still running (goleak in the engine/httpapi packages relies on this
// same discipline in cmd/api).
func TestRunnerShutdownDrains(t *testing.T) {
	runner := NewRunner(context.Background(), quiet())
	var running atomic.Int32
	for i := 0; i < 4; i++ {
		runner.Go("loop", func(ctx context.Context) {
			running.Add(1)
			defer running.Add(-1)
			<-ctx.Done()
		})
	}
	deadline := time.Now().Add(2 * time.Second)
	for running.Load() != 4 {
		if time.Now().After(deadline) {
			t.Fatalf("loops never started: %d", running.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	runner.Shutdown()
	if running.Load() != 0 {
		t.Fatalf("shutdown returned with %d loops alive", running.Load())
	}
}

// A clean return (work finished) is done, not restarted.
func TestRunnerCleanReturnIsFinal(t *testing.T) {
	runner := NewRunner(context.Background(), quiet())
	var starts atomic.Int32
	runner.Go("oneshot", func(ctx context.Context) { starts.Add(1) })
	time.Sleep(300 * time.Millisecond)
	if starts.Load() != 1 {
		t.Fatalf("clean return must not restart: %d starts", starts.Load())
	}
	runner.Shutdown()
}
