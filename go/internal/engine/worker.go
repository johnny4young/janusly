// Worker pool — the queue's consuming side. N goroutines each claim one
// queued node at a time via SKIP LOCKED; an idle worker sleeps until either
// the LISTEN connection reports a wake-up or the polling fallback fires (the
// fallback is what keeps the queue alive when a notification is lost or no
// listener was up when it fired).
//
// Shutdown drains: cancelling the pool's context stops further claims, but
// a node already claimed finishes executing and commits its completion on a
// detached context — a restart therefore never finds rows this process left
// in `running`.
package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/store"
)

// ExecuteFunc runs one claimed node and returns its output. The pool owns
// every status transition: an error return becomes the node's terminal
// failure, anything else commits as success.
type ExecuteFunc func(ctx context.Context, claim ClaimedNode, node domain.Node, wf *domain.Workflow) (any, error)

// wakeChannel is the LISTEN/NOTIFY channel shared with run start and node
// completion; the payload (a run id) is a hint only — claims are global.
const wakeChannel = "janusly_go_wake"

// RunWorkers runs the pool until ctx is cancelled, then drains in-flight
// work and returns. Concurrency and poll interval come validated from
// config.
func (e *Engine) RunWorkers(ctx context.Context, concurrency int, poll time.Duration, execute ExecuteFunc, logger *slog.Logger) error {
	wake := make(chan struct{}, 1)

	var listeners sync.WaitGroup
	listeners.Add(1)
	go func() {
		defer listeners.Done()
		e.listenForWakeups(ctx, wake, logger)
	}()

	var workers sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			e.workerLoop(ctx, wake, poll, execute, logger)
		}()
	}
	workers.Wait()
	listeners.Wait()
	return nil
}

// workerLoop claims and executes one node at a time. Claimed work executes
// on a context detached from cancellation so shutdown finishes what this
// worker already owns.
func (e *Engine) workerLoop(ctx context.Context, wake <-chan struct{}, poll time.Duration, execute ExecuteFunc, logger *slog.Logger) {
	q := store.New(e.pool)
	for {
		if ctx.Err() != nil {
			return
		}
		claims, err := q.ClaimQueuedRunNodes(ctx, 1)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			logger.Error("claim failed", "error", err)
			claims = nil
		}
		if len(claims) == 0 {
			select {
			case <-wake:
			case <-time.After(poll):
			case <-ctx.Done():
				return
			}
			continue
		}
		claim := ClaimedNode{
			RowID: claims[0].ID, RunID: claims[0].RunID,
			NodeID: claims[0].NodeID, Attempt: claims[0].Attempt,
		}
		e.executeClaim(context.WithoutCancel(ctx), claim, execute, logger)
	}
}

// executeClaim loads the run snapshot, dispatches the executor and commits
// the outcome. A persistence error here leaves the row in `running` for the
// stalled-node reaper — logged loudly, never swallowed silently.
func (e *Engine) executeClaim(ctx context.Context, claim ClaimedNode, execute ExecuteFunc, logger *slog.Logger) {
	q := store.New(e.pool)
	run, err := q.GetRunExecution(ctx, claim.RunID)
	if err != nil {
		logger.Error("load run for claim failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
		return
	}
	wf, err := workflowFromRunInput(run.InputJson)
	if err != nil {
		e.failClaim(ctx, claim, err, logger)
		return
	}
	var node *domain.Node
	for i := range wf.Nodes {
		if wf.Nodes[i].ID == claim.NodeID {
			node = &wf.Nodes[i]
			break
		}
	}
	if node == nil {
		e.failClaim(ctx, claim, fmt.Errorf("node %s not in run workflow snapshot", claim.NodeID), logger)
		return
	}

	output, execErr := runExecutor(ctx, claim, *node, wf, execute)
	if execErr != nil {
		e.failClaim(ctx, claim, execErr, logger)
		return
	}
	if err := e.CompleteNode(ctx, claim, output); err != nil {
		logger.Error("complete node failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
	}
}

// runExecutor isolates executor panics so one broken node can't take the
// worker goroutine (and its claim slot) down with it.
func runExecutor(ctx context.Context, claim ClaimedNode, node domain.Node, wf *domain.Workflow, execute ExecuteFunc) (output any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("executor panic: %v", r)
		}
	}()
	return execute(ctx, claim, node, wf)
}

func (e *Engine) failClaim(ctx context.Context, claim ClaimedNode, cause error, logger *slog.Logger) {
	if err := e.FailNode(ctx, claim, cause); err != nil {
		logger.Error("fail node failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
	}
}

// listenForWakeups owns one dedicated connection subscribed to the wake
// channel and forwards notifications as a coalesced signal. Connection loss
// re-subscribes with backoff; while down, the polling fallback carries the
// queue.
func (e *Engine) listenForWakeups(ctx context.Context, wake chan<- struct{}, logger *slog.Logger) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := e.listenOnce(ctx, wake); err != nil && ctx.Err() == nil {
			logger.Warn("wake listener lost; polling carries the queue until resubscribed", "error", err)
			select {
			case <-time.After(time.Second):
			case <-ctx.Done():
				return
			}
		}
	}
}

func (e *Engine) listenOnce(ctx context.Context, wake chan<- struct{}) error {
	pooled, err := e.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire listen connection: %w", err)
	}
	// Hijack: LISTEN state and blocking waits make this connection unfit to
	// return to the pool; it is owned and closed here.
	conn := pooled.Hijack()
	defer func() { _ = conn.Close(context.Background()) }()

	if _, err := conn.Exec(ctx, "listen "+wakeChannel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	for {
		if _, err := conn.WaitForNotification(ctx); err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return fmt.Errorf("wait for notification: %w", err)
		}
		select {
		case wake <- struct{}{}:
		default:
		}
	}
}
