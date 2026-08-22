// Minimal retention sweep — the deferred hard cascade for soft-deleted
// workflows. The contract's system:retention cron purges per-org with a
// tenant-configurable window; the runtime sweeps globally with one default
// window (30 days, env JANUSLY_RETENTION_DELETED_WORKFLOWS_DAYS), using
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

	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

const retentionDefaultDays = 30

// RetentionDays resolves the tombstone window from the environment.
func RetentionDays() int {
	if raw := os.Getenv("JANUSLY_RETENTION_DELETED_WORKFLOWS_DAYS"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 {
			return parsed
		}
	}
	return retentionDefaultDays
}

// ProcessRetentionSweep purges workflows tombstoned longer than each
// org's catalog window (retention.deletedWorkflowsDays: tenant row → env
// → default 30). The passed retentionDays is the legacy global fallback
// used only when the catalog resolution yields nothing sane.
func (e *Engine) ProcessRetentionSweep(ctx context.Context, retentionDays int) (int, error) {
	q := store.New(e.pool)
	orgs, err := q.ListOrgsWithSoftDeletedWorkflows(ctx)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, orgID := range orgs {
		windowDays := int(orgconfig.LoadNumber(ctx, e.pool, orgID, "retention.deletedWorkflowsDays"))
		if windowDays < 1 {
			windowDays = retentionDays
		}
		cutoff := e.now().UTC().AddDate(0, 0, -windowDays)
		deleted, err := q.PurgeExpiredSoftDeletedWorkflowsForOrg(ctx, store.PurgeExpiredSoftDeletedWorkflowsForOrgParams{
			TargetOrg: orgID, Cutoff: cutoff,
		})
		if err != nil {
			return total, err
		}
		total += int(deleted)
	}
	return total, nil
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
		// Expired limiter windows ride the same maintenance cadence: their
		// expiry is in the row, so the delete is safe at any interval.
		if _, err := store.New(e.pool).CleanupExpiredRateWindows(ctx); err != nil && ctx.Err() == nil {
			logger.Error("rate-window cleanup failed", "error", err)
		}
		// Expired SSO nonces authorize nothing and only accumulate — the
		// unauthenticated /auth/sso/start writes one row per request.
		if _, err := store.New(e.pool).CleanupExpiredSsoNonces(ctx); err != nil && ctx.Err() == nil {
			logger.Error("sso-nonce cleanup failed", "error", err)
		}
		// Heartbeat rows silent for a day belong to long-dead instances.
		if _, err := store.New(e.pool).DeleteSilentWorkerInstances(ctx); err != nil && ctx.Err() == nil {
			logger.Error("worker-instance cleanup failed", "error", err)
		}
		// Per-org data retention (run_events / audit_logs / usage_events).
		e.runDataRetention(ctx, logger)
	}
}
