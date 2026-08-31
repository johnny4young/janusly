// The `schedule` node's dispatch substrate (reference schedule.ts +
// schedule-scheduler.ts + syncWorkflowSchedules). The runtime has no external queue service
// job scheduler: each schedule_entries row carries its own `nextFireAt`
// due clock (the replay-campaign pattern) and a leased sweep claims due
// rows with FOR UPDATE SKIP LOCKED.
//
// Invariants:
//   - Save/rollback/restore REPLACE the workflow's entry set from the new
//     latest version; soft delete removes every entry (a tombstoned
//     workflow must never fire — and the sweep's active-parent guard is
//     the second lock on that door).
//   - The pause table's `schedule` row: a paused workflow DROPS the tick,
//     loudly (audited). "The 3am run" means nothing at 6am, and replaying
//     hours of ticks on resume is a thundering herd — the opposite of what
//     pausing was for. The next scheduled fire after resume is correct.
//   - A drop or a fire both advance the clock from the entry's cron; an
//     unparseable expression (drifted data) disables the entry loudly.
package engine

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/cron"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/observability"
	"github.com/johnny4young/janusly/internal/store"
)

const scheduleSweepLimit = 200

// SyncWorkflowSchedules replaces the workflow's schedule entries from one
// version snapshot. Call with the queries handle of the SAME transaction
// that persisted the version, so the entry set can never drift from the
// saved DAG.
func (e *Engine) SyncWorkflowSchedules(
	ctx context.Context, q *store.Queries,
	orgID, workflowID, versionID, createdBy string, wf *domain.Workflow,
) error {
	if err := q.DeleteScheduleEntriesForWorkflow(ctx, store.DeleteScheduleEntriesForWorkflowParams{
		OrgID: orgID, WorkflowID: workflowID,
	}); err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, node := range wf.Nodes {
		if node.Type != "schedule" {
			continue
		}
		config, err := domain.ResolveScheduleConfig(node.Config)
		if err != nil || !config.Enabled {
			// Save-time validation rejects malformed configs; disabled schedules
			// deliberately have no durable scheduler entry.
			continue
		}
		schedule, err := cron.Parse(config.CronExpression)
		if err != nil {
			// Save-time validation rejects bad cron; a snapshot that slipped
			// past simply registers nothing for this node.
			continue
		}
		next, err := schedule.Next(now)
		if err != nil {
			continue
		}
		if err := q.UpsertScheduleEntry(ctx, store.UpsertScheduleEntryParams{
			ID: e.newID(), OrgID: orgID, WorkflowID: workflowID,
			WorkflowVersionID: versionID, NodeID: node.ID,
			CronExpression: config.CronExpression, NextFireAt: &next,
			CreatedBy: pgtype.Text{String: createdBy, Valid: createdBy != ""},
		}); err != nil {
			return err
		}
	}
	return nil
}

// SweepDueSchedules leases due entries and fires (or drops) each tick.
func (e *Engine) SweepDueSchedules(ctx context.Context) (fired, dropped int) {
	now := time.Now().UTC()
	lease := now.Add(time.Minute)
	due, err := store.New(e.pool).ClaimDueScheduleEntries(ctx, store.ClaimDueScheduleEntriesParams{
		Now: &now, LeaseUntil: &lease, RowLimit: scheduleSweepLimit,
	})
	if err != nil {
		return 0, 0
	}
	for _, entry := range due {
		if e.fireScheduleEntry(ctx, entry, now) {
			fired++
		} else {
			dropped++
		}
	}
	return fired, dropped
}

// fireScheduleEntry handles one due tick; returns true when a run started.
func (e *Engine) fireScheduleEntry(ctx context.Context, entry store.ClaimDueScheduleEntriesRow, now time.Time) bool {
	q := store.New(e.pool)
	schedule, err := cron.Parse(entry.CronExpression)
	if err != nil {
		// Drifted data can't compute a next fire — disable loudly rather
		// than lease-spin forever.
		_ = q.DisableScheduleEntry(ctx, entry.ID)
		audit.Write(ctx, e.pool, &auth.Context{OrgID: entry.OrgID, UserID: "system:scheduler"},
			"schedule.entry.disabled", audit.Options{
				TargetType: "schedule_entry", TargetID: entry.ID,
				Metadata: map[string]any{"reason": "invalid_cron", "workflowId": entry.WorkflowID},
			})
		return false
	}
	next, err := schedule.Next(now)
	if err != nil {
		_ = q.DisableScheduleEntry(ctx, entry.ID)
		return false
	}
	advance := func(runID string) {
		_ = q.AdvanceScheduleEntry(ctx, store.AdvanceScheduleEntryParams{
			ID: entry.ID, NextFireAt: &next, LastRunAt: &now, LastRunID: runID,
		})
	}

	// Active-parent guard: a stale entry must never re-run a tombstoned or
	// foreign workflow (delete the orphan entry), and a paused workflow
	// DROPS the tick loudly.
	owner, err := q.GetWorkflowIngestState(ctx, entry.WorkflowID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_ = q.DeleteScheduleEntry(ctx, entry.ID)
		}
		return false
	}
	if owner.OrgID != entry.OrgID || owner.DeletedAt != nil {
		_ = q.DeleteScheduleEntry(ctx, entry.ID)
		return false
	}
	if owner.Status != "" && owner.Status != "active" {
		audit.Write(ctx, e.pool, &auth.Context{OrgID: entry.OrgID, UserID: "system:scheduler"},
			"schedule.tick.dropped", audit.Options{
				TargetType: "workflow", TargetID: entry.WorkflowID,
				Metadata: map[string]any{
					"reason": owner.Status, "nodeId": entry.NodeID,
					"scheduledAt": now.Format(time.RFC3339),
				},
			})
		advance("")
		return false
	}

	version, err := q.GetWorkflowVersionByID(ctx, store.GetWorkflowVersionByIDParams{
		ID: entry.WorkflowVersionID, OrgID: entry.OrgID, WorkflowID: entry.WorkflowID,
	})
	if err != nil {
		_ = q.DeleteScheduleEntry(ctx, entry.ID)
		return false
	}
	wf, _ := domain.Parse(version.DagJson)
	if wf == nil {
		advance("")
		return false
	}
	nodePresent := false
	for _, node := range wf.Nodes {
		if node.ID == entry.NodeID && node.Type == "schedule" {
			nodePresent = true
			break
		}
	}
	if !nodePresent {
		_ = q.DeleteScheduleEntry(ctx, entry.ID)
		return false
	}

	// The tick's identity is its LOGICAL due time, not this attempt: a
	// lease that expires mid-batch, a crash between the run insert and the
	// advance, or a second replica claiming the same entry must all resolve
	// to one run. dueAt is the pre-claim next_fire_at.
	dueAt := now
	if entry.DueAt != nil {
		dueAt = entry.DueAt.UTC()
	}
	runID, err := e.StartRun(ctx, StartInput{
		OrgID: entry.OrgID, Workflow: wf, WorkflowVersionID: entry.WorkflowVersionID,
		CreatedBy:      "system:scheduler",
		IdempotencyKey: "schedule:" + entry.ID + "@" + dueAt.Format(time.RFC3339Nano),
		Input: map[string]any{
			"triggeredBy": "schedule", "nodeId": entry.NodeID,
			"scheduledAt": dueAt.Format(time.RFC3339),
		},
	})
	if err != nil {
		var replay *ErrStartIdempotencyReplay
		if errors.As(err, &replay) {
			// This tick already fired; only the clock advance was lost.
			advance(replay.RunID)
			return false
		}
		// The lease already pushed the clock a minute out — the next sweep
		// retries naturally; nothing to do beyond not advancing last_run.
		return false
	}
	advance(runID)
	return true
}

// RunScheduleSweep loops the due-clock sweep until the context ends.
func (e *Engine) RunScheduleSweep(ctx context.Context, every time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		started := time.Now()
		fired, dropped := e.SweepDueSchedules(ctx)
		observability.ObserveSweepPass(observability.SweepSchedule, started, nil)
		if fired > 0 || dropped > 0 {
			logger.Info("schedule sweep", "fired", fired, "dropped", dropped)
		}
	}
}
