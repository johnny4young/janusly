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
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/store"

	"go.opentelemetry.io/otel/attribute"

	"github.com/johnny4young/janusly/go/internal/observability"
)

// ExecuteFunc runs one claimed node and returns its output. The pool owns
// every status transition: an error return becomes the node's terminal
// failure, anything else commits as success.
type ExecuteFunc func(ctx context.Context, claim ClaimedNode, node domain.Node, wf *domain.Workflow, runInput map[string]any) (any, error)

// wakeChannel is the LISTEN/NOTIFY channel shared with run start and node
// completion; the payload (a run id) is a hint only — claims are global.
const wakeChannel = "janusly_go_wake"

// RunWorkers runs the pool until ctx is cancelled, then drains in-flight
// work and returns. Concurrency and poll interval come validated from
// config.
func (e *Engine) RunWorkers(ctx context.Context, concurrency int, poll time.Duration, execute ExecuteFunc, logger *slog.Logger) error {
	wake := make(chan struct{}, 1)

	var listeners sync.WaitGroup
	listeners.Go(func() {
		e.listenForWakeups(ctx, wake, logger)
	})

	var sweepers sync.WaitGroup
	sweepers.Go(func() {
		e.sweepWakeups(ctx, wake, poll, logger)
	})

	var workers sync.WaitGroup
	for range concurrency {
		workers.Go(func() {
			e.workerLoop(ctx, wake, poll, execute, logger)
		})
	}
	workers.Wait()
	listeners.Wait()
	sweepers.Wait()
	return nil
}

// workerLoop claims and executes one node at a time. Claimed work executes
// on a context detached from cancellation so shutdown finishes what this
// worker already owns.
func (e *Engine) workerLoop(ctx context.Context, wake <-chan struct{}, poll time.Duration, execute ExecuteFunc, logger *slog.Logger) {
	for {
		if ctx.Err() != nil {
			return
		}
		claims, err := e.claimBatch(ctx, 1)
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
		e.executeClaim(context.WithoutCancel(ctx), claims[0], execute, logger)
	}
}

// claimBatch runs the two-statement claim in one transaction: lock
// candidates under SKIP LOCKED, then flip them to running with every guard
// re-checked on a FRESH statement snapshot — the EvalPlanQual-safe shape
// (see the query comments in queries.sql).
func (e *Engine) claimBatch(ctx context.Context, batch int32) ([]ClaimedNode, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	ids, err := q.LockClaimableRunNodes(ctx, batch)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, tx.Commit(ctx)
	}
	rows, err := q.MarkLockedNodesRunning(ctx, ids)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	metricClaims.Add(float64(len(rows)))
	// The reference appends node.running right after the claim wins
	// (runtime.ts). Best-effort like its await-outside-tx posture: event
	// telemetry never blocks execution, and the executor's own terminal
	// event still lands if this insert hits a blip.
	for _, row := range rows {
		attemptPayload, _ := json.Marshal(map[string]any{"attempt": row.Attempt})
		runningAt := eventNow()
		if err := store.New(e.pool).InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: row.RunID,
			NodeID: pgtype.Text{String: row.NodeID, Valid: true},
			Type:   "node.running", Payload: attemptPayload,
			CreatedAt: &runningAt,
		}); err != nil && ctx.Err() == nil {
			slog.Warn("node.running event insert failed", "runId", row.RunID, "nodeId", row.NodeID, "error", err)
		}
	}
	claims := make([]ClaimedNode, 0, len(rows))
	for _, row := range rows {
		claims = append(claims, ClaimedNode{
			RowID: row.ID, RunID: row.RunID, NodeID: row.NodeID, Attempt: row.Attempt,
		})
	}
	return claims, nil
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
	claim.OrgID = run.OrgID
	wf, runInput, err := workflowFromRunInput(run.InputJson)
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

	executionStart := time.Now()
	output, execErr := runExecutor(ctx, claim, *node, wf, runInput, execute)
	metricNodeExecution.Observe(time.Since(executionStart).Seconds())
	if execErr != nil {
		if err := e.RetryOrFail(ctx, claim, *node, execErr); err != nil {
			logger.Error("retry-or-fail failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
		}
		// A failure may have flipped the run terminal — deliver any armed
		// parent handoff immediately (the reconciler covers crashes).
		e.DeliverParentNotifications(ctx, claim.RunID)
		return
	}
	if waiting, ok := output.(executors.Waiting); ok {
		if err := e.MarkNodeWaiting(ctx, claim, waiting); err != nil {
			logger.Error("mark waiting failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
		}
		return
	}
	if err := e.CompleteNode(ctx, claim, output); err != nil {
		logger.Error("complete node failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
	}
	e.DeliverParentNotifications(ctx, claim.RunID)
}

// runExecutor isolates executor panics so one broken node can't take the
// worker goroutine (and its claim slot) down with it.
func runExecutor(ctx context.Context, claim ClaimedNode, node domain.Node, wf *domain.Workflow, runInput map[string]any, execute ExecuteFunc) (output any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("executor panic: %v", r)
		}
	}()
	// One OTel span per claimed execution (reference worker.ts withSpan);
	// a no-op unless a provider is registered, so untraced runs pay ~0.
	spanErr := observability.WithSpan(ctx, "node.execute", []attribute.KeyValue{
		attribute.String("janusly.run_id", claim.RunID),
		attribute.String("janusly.node_id", claim.NodeID),
		attribute.String("janusly.node_type", node.Type),
		attribute.Int("janusly.attempt", int(claim.Attempt)),
	}, func(spanCtx context.Context) error {
		output, err = execute(spanCtx, claim, node, wf, runInput)
		return err
	})
	_ = spanErr // identical to err; the span already recorded it
	return output, err
}

func (e *Engine) failClaim(ctx context.Context, claim ClaimedNode, cause error, logger *slog.Logger) {
	if err := e.FailNode(ctx, claim, cause); err != nil {
		logger.Error("fail node failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
	}
}

// sweepWakeups garbage-collects due wake-up rows on the poll cadence and
// nudges idle workers when any were due. Claim correctness never depends on
// it — the claim's anti-join compares wake_at to now() directly.
func (e *Engine) sweepWakeups(ctx context.Context, wake chan<- struct{}, poll time.Duration, logger *slog.Logger) {
	q := store.New(e.pool)
	for {
		select {
		case <-time.After(poll):
		case <-ctx.Done():
			return
		}
		resumed := e.resumeDueTimers(ctx, q)
		swept, err := q.SweepDueWakeups(ctx)
		if err != nil {
			if ctx.Err() == nil {
				logger.Error("wakeup sweep failed", "error", err)
			}
			continue
		}
		if swept > 0 || resumed > 0 {
			select {
			case wake <- struct{}{}:
			default:
			}
		}
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
