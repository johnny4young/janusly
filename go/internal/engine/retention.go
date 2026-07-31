// Minimal retention sweep — the deferred hard cascade for soft-deleted
// workflows. The reference's system:retention cron purges per-org with a
// tenant-configurable window; the pilot sweeps globally with one default
// window (30 days, env JANUSLY_GO_RETENTION_DELETED_WORKFLOWS_DAYS), using
// the same atomic CTE shape: versions + metadata + workflow rows go
// together or not at all. Orphaned runs / audit rows stay, per the
// repo-wide orphan-tolerant cascade posture.
package engine

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/go/internal/store"
)

const retentionDefaultDays = 30

// RetentionDays resolves the tombstone window from the environment.
func RetentionDays() int {
	if raw := os.Getenv("JANUSLY_GO_RETENTION_DELETED_WORKFLOWS_DAYS"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 {
			return parsed
		}
	}
	return retentionDefaultDays
}

// ProcessRetentionSweep purges workflows tombstoned longer than the window.
func (e *Engine) ProcessRetentionSweep(ctx context.Context, retentionDays int) (int, error) {
	cutoff := e.now().UTC().AddDate(0, 0, -retentionDays)
	deleted, err := store.New(e.pool).PurgeExpiredSoftDeletedWorkflows(ctx, cutoff)
	if err != nil {
		return 0, err
	}
	return int(deleted), nil
}

// RunRetentionSweep runs the sweep on an interval until the context ends.
func (e *Engine) RunRetentionSweep(ctx context.Context, every time.Duration, retentionDays int, logger *slog.Logger) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		deleted, err := e.ProcessRetentionSweep(ctx, retentionDays)
		if err != nil {
			if ctx.Err() == nil {
				logger.Error("retention sweep failed", "error", err)
			}
			continue
		}
		if deleted > 0 {
			logger.Info("retention sweep purged tombstoned workflows", "count", deleted, "windowDays", retentionDays)
		}
	}
}
