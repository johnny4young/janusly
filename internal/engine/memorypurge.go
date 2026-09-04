// Consent-revocation memory purge (reference memory-purge-scheduler.ts,
// due-clock shaped). The canonical memory policy promises: when an admin
// flips org_configs `memory.enabled` from true to false, every
// memory_entries row for the org is purged within 7 days. The runtime
// enforces it with a periodic durable sweep: any org
// whose `memory.enabled=false` flip is older than the delay AND still has
// memory rows gets purged, audited as `memory.bulk.purged`.
//
// Defense-in-depth lives at FIRE time: the sweep re-reads the config on
// every pass, so re-granting consent inside the window simply makes the
// org invisible to the sweep — no cancellation bookkeeping to get wrong.
// Never throws; a missed pass is repaired by the next tick.
package engine

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/observability"
	"github.com/johnny4young/janusly/internal/store"
)

// memoryPurgeDelay resolves the revocation grace window (default 7 days).
func MemoryPurgeDelay() time.Duration {
	if raw := os.Getenv("JANUSLY_MEMORY_PURGE_DELAY_HOURS"); raw != "" {
		if hours, err := strconv.Atoi(raw); err == nil && hours >= 0 && hours <= 24*30 {
			return time.Duration(hours) * time.Hour
		}
	}
	return 7 * 24 * time.Hour
}

// SweepMemoryConsentPurges purges every org whose revocation aged past
// the window. Returns orgs purged.
func (e *Engine) SweepMemoryConsentPurges(ctx context.Context) (int, error) {
	q := store.New(e.pool)
	cutoff := time.Now().Add(-MemoryPurgeDelay())
	rows, err := q.ListMemoryConsentRevokedOrgs(ctx, &cutoff)
	if err != nil {
		return 0, err
	}
	purged := 0
	// One org's failure must not stop the others; the first error is still
	// the pass's verdict so the failure counter moves.
	var firstErr error
	for _, row := range rows {
		deleted, err := q.PurgeMemoryEntriesForOrg(ctx, row.OrgID)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if deleted == 0 {
			continue
		}
		purged++
		audit.Write(ctx, e.pool, &auth.Context{OrgID: row.OrgID, UserID: "system:memory-purge"},
			"memory.bulk.purged", audit.Options{
				TargetType: "org", TargetID: row.OrgID,
				Metadata: map[string]any{
					"entries": deleted, "reason": "consent_revoked",
					"revokedAt": row.UpdatedAt.UTC().Format(time.RFC3339),
				},
			})
	}
	return purged, firstErr
}

// RunMemoryConsentPurgeSweep loops the sweep until the context ends.
func (e *Engine) RunMemoryConsentPurgeSweep(ctx context.Context, every time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		started := time.Now()
		purged, err := e.SweepMemoryConsentPurges(ctx)
		observability.ObserveSweepPass(observability.SweepMemoryConsentPurge, started, err)
		if purged > 0 {
			logger.Info("memory consent purge sweep", "orgsPurged", purged)
		}
	}
}
