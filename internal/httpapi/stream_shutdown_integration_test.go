//go:build integration

package httpapi

import (
	"context"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/engine"
)

// The stream hub holds a hijacked LISTEN connection. "Every background loop
// is supervised and drains before pools close" means shutdown must wait for
// it — an orphaned hub keeps a pool connection alive past pool.Close and
// swallows its own panics unseen.
func TestShutdownJoinsTheUnsupervisedStreamHub(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test-integration`")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	options := DefaultV1ServerOptions()
	options.Logger = quietTestLogger()
	_, shutdown, err := NewV1HandlerWithOptions(engine.New(pool), pool, options)
	if err != nil {
		t.Fatal(err)
	}
	// Give the hub a moment to acquire and hijack its LISTEN connection.
	time.Sleep(200 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := time.Now()
	if err := shutdown(ctx); err != nil {
		t.Fatalf("shutdown must join the hub within its deadline: %v", err)
	}
	if time.Since(started) > 4*time.Second {
		t.Fatal("shutdown took the whole deadline; the hub did not stop on cancel")
	}
}

// Under the process runner the hub is just another named loop: it runs on the
// runner's context, so shutdown of the handler does not block on it — the
// runner drains it, in order, before the pools close.
func TestSupervisedStreamHubRunsUnderTheRunnerContext(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test-integration`")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var name atomic.Value
	loopDone := make(chan struct{})
	runnerCtx, stopRunner := context.WithCancel(context.Background())
	options := DefaultV1ServerOptions()
	options.Logger = quietTestLogger()
	options.Supervise = func(n string, fn func(ctx context.Context)) {
		name.Store(n)
		go func() {
			defer close(loopDone)
			fn(runnerCtx)
		}()
	}
	_, shutdown, err := NewV1HandlerWithOptions(engine.New(pool), pool, options)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := name.Load().(string); got != "stream-hub" {
		t.Fatalf("hub must register under its own sweep name, got %q", got)
	}

	// Handler shutdown does not own the supervised loop, so it returns at once…
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-loopDone:
		// The server context is one of the loop's stop signals too, so an
		// early exit here is acceptable; the assertion below is the one
		// that matters.
	default:
	}
	// …and the loop stops when the runner says so.
	stopRunner()
	select {
	case <-loopDone:
	case <-time.After(5 * time.Second):
		t.Fatal("supervised hub loop ignored the runner's cancellation")
	}
}
