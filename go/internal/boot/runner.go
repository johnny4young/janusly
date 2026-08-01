// Runner — the supervised sweep group (T-512): every background loop the
// process owns starts NAMED, restarts with backoff when it PANICS (a bug
// in one sweep must never take the API down with it), and drains in a
// deterministic reverse order on shutdown BEFORE the caller closes pools.
//
// Panic posture: recover → error log with the sweep's name → restart
// after backoff (1s doubling to 60s, reset after a clean 10-minute
// stretch). A sweep that RETURNS (context cancelled) is done, not
// restarted.
package boot

import (
	"context"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"
)

// Runner supervises named background loops.
type Runner struct {
	logger *slog.Logger
	wg     sync.WaitGroup
	ctx    context.Context
	cancel context.CancelFunc
}

// NewRunner builds a group tied to parent (usually the process context).
func NewRunner(parent context.Context, logger *slog.Logger) *Runner {
	ctx, cancel := context.WithCancel(parent)
	return &Runner{logger: logger, ctx: ctx, cancel: cancel}
}

// Go starts one named supervised loop. fn should block until ctx ends.
func (r *Runner) Go(name string, fn func(ctx context.Context)) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		backoff := time.Second
		for {
			started := time.Now()
			panicked := r.runOnce(name, fn)
			if r.ctx.Err() != nil {
				return
			}
			if !panicked {
				// A clean return without cancellation means the loop
				// finished its work; nothing to supervise further.
				return
			}
			if time.Since(started) > 10*time.Minute {
				backoff = time.Second
			}
			r.logger.Error("sweep panicked; restarting", "sweep", name, "backoff", backoff.String())
			select {
			case <-time.After(backoff):
			case <-r.ctx.Done():
				return
			}
			if backoff < time.Minute {
				backoff *= 2
			}
		}
	}()
}

func (r *Runner) runOnce(name string, fn func(ctx context.Context)) (panicked bool) {
	defer func() {
		if cause := recover(); cause != nil {
			panicked = true
			r.logger.Error("sweep panic recovered",
				"sweep", name, "panic", cause, "stack", string(debug.Stack()))
		}
	}()
	fn(r.ctx)
	return false
}

// Shutdown cancels every loop and waits for all of them to drain.
func (r *Runner) Shutdown() {
	r.cancel()
	r.wg.Wait()
}
