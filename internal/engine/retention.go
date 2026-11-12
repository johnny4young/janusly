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
	"errors"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/observability"
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

const agentSessionPurgeBatch = 200

// PurgeExpiredAgentSessions drops hooks-bridge sessions silent past their
// retention, with their events, in bounded batches.
func (e *Engine) PurgeExpiredAgentSessions(ctx context.Context) (int, error) {
	cutoff := e.now().UTC().Add(-agentsession.Retention)
	total := 0
	for range retentionMaxBatchesDefault {
		deleted, err := store.New(e.pool).DeleteExpiredAgentSessionsBatch(ctx, store.DeleteExpiredAgentSessionsBatchParams{
			Cutoff: cutoff, BatchSize: agentSessionPurgeBatch,
		})
		if err != nil {
			return total, err
		}
		total += int(deleted)
		if deleted < agentSessionPurgeBatch {
			break
		}
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
		started := time.Now()
		deleted, err := e.ProcessRetentionSweep(ctx, retentionDays)
		if err != nil {
			observability.ObserveSweepPass(observability.SweepRetention, started, err)
			if ctx.Err() == nil {
				logger.Error("retention sweep failed", "error", err)
			}
			continue
		}
		var passErr error
		if deleted > 0 {
			logger.Info("retention sweep purged tombstoned workflows", "count", deleted, "windowDays", retentionDays)
		}
		// Expired limiter windows ride the same maintenance cadence: their
		// expiry is in the row, so the delete is safe at any interval.
		if _, err := store.New(e.pool).CleanupExpiredRateWindows(ctx); err != nil {
			passErr = errors.Join(passErr, err)
			if ctx.Err() == nil {
				logger.Error("rate-window cleanup failed", "error", err)
			}
		}
		// Expired SSO nonces authorize nothing and only accumulate — the
		// unauthenticated /auth/sso/start writes one row per request.
		if _, err := store.New(e.pool).CleanupExpiredSsoNonces(ctx); err != nil {
			passErr = errors.Join(passErr, err)
			if ctx.Err() == nil {
				logger.Error("sso-nonce cleanup failed", "error", err)
			}
		}
		// Heartbeat rows silent for a day belong to long-dead instances.
		if _, err := store.New(e.pool).DeleteSilentWorkerInstances(ctx); err != nil {
			passErr = errors.Join(passErr, err)
			if ctx.Err() == nil {
				logger.Error("worker-instance cleanup failed", "error", err)
			}
		}
		// Eval datasets own optional finite retention windows. Their consented
		// examples expire atomically with the parent while immutable experiment
		// summaries remain available as aggregate evidence.
		if err := e.runEvalDatasetRetention(ctx, logger); err != nil {
			passErr = errors.Join(passErr, err)
		}
		// Explicit authoring registrations expire or remain revoked even if
		// tenant consent is later restored. Reuse the supervised cadence.
		now := e.now().UTC()
		if _, err := store.New(e.pool).PurgeAuthoringExperiencesBatch(ctx, store.PurgeAuthoringExperiencesBatchParams{AsOf: now, RevokedBefore: now.Add(-MemoryPurgeDelay()), BatchSize: 1000}); err != nil {
			passErr = errors.Join(passErr, err)
			if ctx.Err() == nil {
				logger.Error("authoring experience retention failed", "error", err)
			}
		}
		if purged, err := e.PurgeExpiredAgentSessions(ctx); err != nil {
			passErr = errors.Join(passErr, err)
			if ctx.Err() == nil {
				logger.Error("agent session retention failed", "error", err)
			}
		} else if purged > 0 {
			logger.Info("retention purged agent sessions", "count", purged)
		}
		// OAuth registrations nobody used, and authorization requests past their life.
		if _, err := store.New(e.pool).DeleteUnusedOAuthClients(ctx, e.now().UTC().Add(-24*time.Hour)); err != nil {
			passErr = errors.Join(passErr, err)
		}
		if _, err := store.New(e.pool).DeleteExpiredOAuthRequests(ctx, e.now().UTC().Add(-24*time.Hour)); err != nil {
			passErr = errors.Join(passErr, err)
		}
		// Captured gate input is kept for a shorter window than its session.
		gateNow := e.now().UTC()
		if _, err := store.New(e.pool).ExpireAgentGates(ctx, gateNow); err != nil {
			passErr = errors.Join(passErr, err)
		}
		if _, err := store.New(e.pool).ClearExpiredAgentGateContent(ctx, gateNow.Add(-agentsession.GateContentRetention)); err != nil {
			passErr = errors.Join(passErr, err)
			if ctx.Err() == nil {
				logger.Error("agent gate content retention failed", "error", err)
			}
		}
		// Per-org data retention (run_events / audit_logs / usage_events).
		e.runDataRetention(ctx, logger)
		// Weekly digests ride the same cadence; the state-row claim keeps
		// them weekly and single-sender regardless of replica count.
		e.processWeeklyDigests(ctx, logger)
		observability.ObserveSweepPass(observability.SweepRetention, started, passErr)
	}
}
