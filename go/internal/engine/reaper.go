// Stalled-node reaper — the recovery mechanism for the one failure the
// atomic claim cannot self-heal: a worker killed mid-execution (kill -9,
// OOM, eviction) leaves its row in `running` forever, the run never reaches
// a terminal state, and no DLQ surface exists for the operator.
//
// The posture is the reference's, deliberately: fail-into-DLQ, NEVER
// auto-re-execute — a stalled node may already have committed a
// non-idempotent side effect, so the operator decides through the ordinary
// redrive surface. The per-node terminal write is FailNode's existing CAS
// transaction, so a node that legitimately completed between scan and write
// is never clobbered, and concurrent replicas cannot double-reap.
package engine

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/go/internal/store"
)

// ReapStalledNodes fails every node stuck in running longer than threshold,
// dead-lettering each through the ordinary terminal-failure transaction.
// Returns how many were reaped; it never fails the sweep as a whole — a
// per-node error logs and moves on (the next sweep retries, the scan is
// idempotent).
func (e *Engine) ReapStalledNodes(ctx context.Context, threshold time.Duration, batch int, logger *slog.Logger) int {
	if batch <= 0 {
		batch = 50
	}
	rows, err := store.New(e.pool).FindStalledRunningNodes(ctx, store.FindStalledRunningNodesParams{
		ThresholdSeconds: threshold.Seconds(), BatchSize: int32(batch),
	})
	if err != nil {
		if ctx.Err() == nil {
			logger.Error("stalled-node scan failed", "error", err)
		}
		return 0
	}
	reaped := 0
	for _, row := range rows {
		claim := ClaimedNode{RowID: row.ID, RunID: row.RunID, NodeID: row.NodeID, Attempt: row.Attempt}
		err := e.FailNode(ctx, claim, &ExecError{
			Message: "Node execution stalled: the worker likely died mid-execution",
			Name:    "StalledNodeError", Code: "WORKER_STALLED",
		})
		if err != nil {
			if ctx.Err() == nil {
				logger.Error("stalled-node reap failed", "runId", row.RunID, "nodeId", row.NodeID, "error", err)
			}
			continue
		}
		reaped++
		metricReapedNodes.Inc()
		logger.Warn("stalled node reaped into the DLQ",
			"runId", row.RunID, "nodeId", row.NodeID, "attempt", row.Attempt)
	}
	return reaped
}

// StartReaper runs the periodic sweep until ctx cancels. The threshold
// floor protects operators from configuring the reaper to kill legitimately
// long executions; tests exercise ReapStalledNodes directly with tighter
// windows.
func (e *Engine) StartReaper(ctx context.Context, interval, threshold time.Duration, logger *slog.Logger) {
	// The floor itself is overridable ONLY by explicit env — the
	// kill-failover harness (and an expert HA operator with short-lived
	// nodes) needs sub-15m recovery; the override logs loudly so a
	// misconfigured production deploy is visible in the first minute.
	thresholdFloor := 15 * time.Minute
	if raw := os.Getenv("JANUSLY_GO_REAPER_THRESHOLD_FLOOR_MS"); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			thresholdFloor = time.Duration(ms) * time.Millisecond
			logger.Warn("reaper threshold floor overridden by env — nodes running longer than the effective threshold WILL be failed into the DLQ",
				"floor", thresholdFloor)
		}
	}
	if threshold < thresholdFloor {
		threshold = thresholdFloor
	}
	if interval <= 0 {
		interval = time.Minute
	}
	for {
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			return
		}
		e.ReapStalledNodes(ctx, threshold, 50, logger)
	}
}
