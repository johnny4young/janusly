// Worker-fleet heartbeats: each process beats one worker_instances row so
// an operator can see how many replicas are live, since when, and on
// which build — the observability half of running more than one replica.
// Purely additive telemetry: a failed beat logs and retries on the next
// tick, never touching execution.
package engine

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

// WorkerHeartbeatInterval is how often a live process beats its row.
// Readers treat anything older than four intervals as stale.
const WorkerHeartbeatInterval = 15 * time.Second

// RunWorkerHeartbeat loops the beat until the context ends. instanceID
// must be stable for the process lifetime; buildCommit may be empty.
func (e *Engine) RunWorkerHeartbeat(ctx context.Context, instanceID string, concurrency int, buildCommit string, logger *slog.Logger) {
	beat := func() {
		if err := store.New(e.pool).UpsertWorkerHeartbeat(ctx, store.UpsertWorkerHeartbeatParams{
			InstanceID:        instanceID,
			WorkerConcurrency: int32(concurrency),
			BuildCommit:       pgtype.Text{String: buildCommit, Valid: buildCommit != ""},
		}); err != nil && ctx.Err() == nil {
			logger.Warn("worker heartbeat failed", "instanceId", instanceID, "error", err)
		}
	}
	beat()
	ticker := time.NewTicker(WorkerHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			beat()
		case <-ctx.Done():
			return
		}
	}
}
