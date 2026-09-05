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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/store"

	"go.opentelemetry.io/otel/attribute"

	"github.com/johnny4young/janusly/internal/observability"
)

// ExecuteFunc runs one claimed node and returns its output. The pool owns
// every status transition: an error return becomes the node's terminal
// failure, anything else commits as success.
type ExecuteFunc func(ctx context.Context, claim ClaimedNode, node domain.Node, wf *domain.Workflow, runInput map[string]any) (any, error)

// wakeChannel is the LISTEN/NOTIFY channel shared with run start and node
// completion; the payload (a run id) is a hint only — claims are global.
const wakeChannel = "janusly_wake"

const (
	// idlePollBackoffSteps/Max bound how far an idle worker backs off.
	idlePollBackoffSteps = 4
	idlePollBackoffMax   = 2 * time.Second
)

// RunWorkers runs the pool until ctx is cancelled, then drains in-flight
// work and returns. Concurrency and poll interval come validated from
// config.
func (e *Engine) RunWorkers(ctx context.Context, concurrency int, poll time.Duration, execute ExecuteFunc, logger *slog.Logger) error {
	// One wake channel per worker. A single NOTIFY used to hand one token to
	// one worker, so a fan-out of N nodes woke one worker and the rest slept
	// through the idle poll backoff; waking every worker instead made each
	// start open eight claim transactions. The notification now says how
	// many nodes became claimable and that many workers wake, round-robin;
	// SKIP LOCKED hands each a different node.
	wakes := make([]chan struct{}, concurrency)
	idle := make([]atomic.Bool, concurrency)
	for i := range wakes {
		wakes[i] = make(chan struct{}, 1)
	}
	wake := newWakeFanout(wakes, idle)

	var listeners sync.WaitGroup
	listeners.Go(func() {
		superviseLoop(ctx, "wakeup-listener", logger, func() {
			e.listenForWakeups(ctx, wake, logger)
		})
	})

	var sweepers sync.WaitGroup
	sweepers.Go(func() {
		superviseLoop(ctx, "wakeup-sweeper", logger, func() {
			e.sweepWakeups(ctx, wake, poll, logger)
		})
	})

	var workers sync.WaitGroup
	for i, ch := range wakes {
		workers.Go(func() {
			superviseLoop(ctx, "worker", logger, func() {
				e.workerLoop(ctx, ch, &idle[i], poll, execute, logger)
			})
		})
	}
	workers.Wait()
	listeners.Wait()
	sweepers.Wait()
	return nil
}

// superviseLoop keeps one pool goroutine alive across panics, mirroring
// boot.Runner's posture for the goroutines it cannot see: executor panics
// are already recovered per-task, but a bug in claim plumbing or a sweep
// must degrade one loop briefly, never take the whole process down.
func superviseLoop(ctx context.Context, name string, logger *slog.Logger, loop func()) {
	for ctx.Err() == nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					logger.Error("worker-pool loop panicked; restarting",
						"loop", name, "panic", fmt.Sprint(r))
				}
			}()
			loop()
		}()
		if ctx.Err() != nil {
			return
		}
		// Reached only after a panic or an unexpected early return —
		// back off so a hard bug cannot spin the loop hot.
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// workerLoop claims and executes one node at a time. Claimed work executes
// on a context detached from cancellation so shutdown finishes what this
// worker already owns.
func (e *Engine) workerLoop(ctx context.Context, wake <-chan struct{}, idle *atomic.Bool, poll time.Duration, execute ExecuteFunc, logger *slog.Logger) {
	misses := 0
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
			misses++
			// Idle is what the wake fan-out targets first: a token handed to
			// a worker busy inside an executor would sit until that node
			// finished, while an idle sibling could have claimed at once.
			idle.Store(true)
			select {
			case <-wake:
				// A notification means work exists: poll tightly again.
				misses = 0
			case <-time.After(idlePollInterval(poll, misses)):
			case <-ctx.Done():
				idle.Store(false)
				return
			}
			idle.Store(false)
			continue
		}
		misses = 0
		e.executeClaim(context.WithoutCancel(ctx), claims[0], execute, logger)
	}
}

// idlePollInterval backs an idle worker off toward idlePollBackoffMax.
// Every worker polls independently, so an idle instance otherwise issues
// concurrency claims per interval forever — 8 workers at 250 ms is ~32
// queue transactions a second against a queue that is empty. LISTEN
// remains the primary wake-up, so the backoff costs latency only when a
// notification is lost.
func idlePollInterval(poll time.Duration, idle int) time.Duration {
	interval := poll
	for range min(idle, idlePollBackoffSteps) {
		interval *= 2
	}
	// The backoff only ever slows polling down: an operator who configured
	// a slower interval than the cap keeps it.
	return min(interval, max(poll, idlePollBackoffMax))
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
	for _, row := range rows {
		metricQueueWait.Observe(row.QueueWaitSeconds)
	}
	// The contract appends node.running right after the claim wins
	// (runtime.ts). Best-effort like its await-outside-tx posture: event
	// telemetry never blocks execution, and the executor's own terminal
	// event still lands if this insert hits a blip.
	for _, row := range rows {
		attemptPayload, _ := json.Marshal(map[string]any{"attempt": row.Attempt})
		runningAt := e.eventNow()
		if err := store.New(e.pool).InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: e.newID(), RunID: row.RunID, OrgID: row.OrgID,
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
			RowID: row.ID, RunID: row.RunID, NodeID: row.NodeID, Attempt: row.Attempt, OrgID: row.OrgID,
		})
	}
	return claims, nil
}

// executeClaim loads the run snapshot, dispatches the executor and commits
// the outcome. A transient persistence error is replayed within a short
// budget (persistOutcome); a permanent one leaves the row in `running` for
// the stalled-node reaper — logged loudly, never swallowed silently.
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
	// The snapshot this executor runs is the one the completion path needs;
	// carrying it avoids refetching and reparsing input_json downstream.
	claim = claim.withSnapshot(wf, runInput, run.ReplayMode.String, run.WorkflowVersionID)
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
	metricNodeExecution.WithLabelValues(node.Type).Observe(time.Since(executionStart).Seconds())
	if execErr != nil {
		if err := e.persistOutcome(ctx, logger, "retry", claim, func() error {
			return e.RetryOrFail(ctx, claim, *node, execErr)
		}); err != nil {
			logger.Error("retry-or-fail failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
		}
		// A failure may have flipped the run terminal — deliver any armed
		// parent handoff immediately (the reconciler covers crashes).
		e.DeliverParentNotifications(ctx, claim.RunID)
		return
	}
	if waiting, ok := output.(executors.Waiting); ok {
		if err := e.persistOutcome(ctx, logger, "waiting", claim, func() error {
			return e.MarkNodeWaiting(ctx, claim, waiting)
		}); err != nil {
			logger.Error("mark waiting failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
		}
		return
	}
	completionErr := e.persistOutcome(ctx, logger, "complete", claim, func() error {
		if router, ok := output.(RouterExecution); ok {
			return e.CompleteRouterNode(ctx, claim, router)
		}
		return e.CompleteNode(ctx, claim, output)
	})
	if completionErr != nil {
		logger.Error("complete node failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", completionErr)
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
	if err := e.persistOutcome(ctx, logger, "fail", claim, func() error {
		return e.FailNode(ctx, claim, cause)
	}); err != nil {
		logger.Error("fail node failed", "runId", claim.RunID, "nodeId", claim.NodeID, "error", err)
	}
}

// sweepWakeups applies due waiting policies, garbage-collects consumed rows,
// and nudges idle workers when any work advanced. Claim correctness never
// depends on it — the claim's anti-join compares wake_at to now() directly.
func (e *Engine) sweepWakeups(ctx context.Context, wake func(int), poll time.Duration, logger *slog.Logger) {
	q := store.New(e.pool)
	for {
		select {
		case <-time.After(poll):
		case <-ctx.Done():
			return
		}
		processed := e.processDueWaitingWakeups(ctx, q)
		swept, err := q.SweepDueWakeups(ctx)
		if err != nil {
			if ctx.Err() == nil {
				logger.Error("wakeup sweep failed", "error", err)
			}
			continue
		}
		if swept > 0 || processed > 0 {
			wake(int(swept) + processed)
		}
	}
}

// listenForWakeups owns one dedicated connection subscribed to the wake
// channel and forwards each notification to every worker as a coalesced
// signal. Connection loss
// re-subscribes with backoff; while down, the polling fallback carries the
// queue.
func (e *Engine) listenForWakeups(ctx context.Context, wake func(int), logger *slog.Logger) {
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

func (e *Engine) listenOnce(ctx context.Context, wake func(int)) error {
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
		notification, err := conn.WaitForNotification(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return fmt.Errorf("wait for notification: %w", err)
		}
		wake(wakeCountFromPayload(notification.Payload))
	}
}

// wakeCountFromPayload reads the ready count a NotifyWake payload carries
// ("<runId>:<n>"); anything else counts as one.
func wakeCountFromPayload(payload string) int {
	if _, raw, ok := strings.Cut(payload, ":"); ok {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			return n
		}
	}
	return 1
}

// newWakeFanout signals up to n distinct worker channels per call: idle
// workers first, rotating the starting point so consecutive wakes spread
// across the pool, then busy ones (their token is consumed when the
// executor returns). A channel that already holds a token counts as woken.
func newWakeFanout(wakes []chan struct{}, idle []atomic.Bool) func(int) {
	var mu sync.Mutex
	next := 0
	signal := func(index int) {
		select {
		case wakes[index] <- struct{}{}:
		default:
		}
	}
	return func(n int) {
		if len(wakes) == 0 {
			return
		}
		n = max(1, min(n, len(wakes)))
		mu.Lock()
		start := next
		next = (next + n) % len(wakes)
		mu.Unlock()
		remaining := n
		for pass := range 2 {
			for i := range len(wakes) {
				if remaining == 0 {
					return
				}
				index := (start + i) % len(wakes)
				if pass == 0 && !idle[index].Load() {
					continue
				}
				if pass == 1 && idle[index].Load() {
					continue
				}
				signal(index)
				remaining--
			}
		}
	}
}
