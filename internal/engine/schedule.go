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
	"fmt"
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

// scheduleSweepWallBudget bounds one sweep below the one-minute lease the
// claim takes: an entry still unfired when the budget runs out is left
// leased and fires on a later sweep once the lease lapses, instead of a
// second replica re-claiming it mid-flight.
const scheduleSweepWallBudget = 45 * time.Second

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
		if err != nil {
			return fmt.Errorf("resolve schedule node %q: %w", node.ID, err)
		}
		if !config.Enabled {
			// Disabled schedules deliberately have no durable scheduler entry.
			continue
		}
		schedule, err := cron.Parse(config.CronExpression)
		if err != nil {
			return fmt.Errorf("parse schedule node %q: %w", node.ID, err)
		}
		next, err := schedule.Next(now)
		if err != nil {
			return fmt.Errorf("advance schedule node %q: %w", node.ID, err)
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
func (e *Engine) SweepDueSchedules(ctx context.Context) (fired, dropped int, err error) {
	now := time.Now().UTC()
	lease := now.Add(time.Minute)
	due, err := store.New(e.pool).ClaimDueScheduleEntries(ctx, store.ClaimDueScheduleEntriesParams{
		Now: &now, LeaseUntil: &lease, RowLimit: scheduleSweepLimit,
	})
	if err != nil {
		// The claim is the sweep's one infrastructure dependency; report it
		// so a scheduler that cannot reach PostgreSQL stops looking healthy.
		return 0, 0, err
	}
	// Entries of the same version share one parsed document for the sweep;
	// a workflow with many schedule nodes no longer re-reads and re-parses
	// its snapshot per tick.
	started := time.Now()
	versions := map[string]parsedVersion{}
	var failed []error
	for index, entry := range due {
		if time.Since(started) > scheduleSweepWallBudget {
			slog.Warn("schedule sweep hit its wall budget; leased entries fire after the lease",
				"deferred", len(due)-index, "budget", scheduleSweepWallBudget)
			break
		}
		ok, fireErr := e.fireScheduleEntry(ctx, entry, now, versions)
		switch {
		case fireErr != nil:
			failed = append(failed, fireErr)
		case ok:
			fired++
		default:
			dropped++
		}
	}
	if len(failed) > 0 {
		// The ticks keep their claim and retry after the lease; the error marks the pass unhealthy.
		slog.Warn("schedule ticks failed and will retry", "failed", len(failed), "error", failed[0])
		return fired, dropped, fmt.Errorf("%d schedule ticks failed: %w", len(failed), errors.Join(failed...))
	}
	return fired, dropped, nil
}

// fireScheduleEntry handles one due tick; returns true when a run started.
// An error is transient: the tick keeps its claim and retries after the lease.
// versions caches parsed documents across the sweep, keyed by tenant,
// workflow and version so the scoped read is never bypassed.
func (e *Engine) fireScheduleEntry(ctx context.Context, entry store.ClaimDueScheduleEntriesRow, now time.Time, versions map[string]parsedVersion) (bool, error) {
	q := store.New(e.pool)
	schedule, err := cron.Parse(entry.CronExpression)
	if err != nil {
		// Drifted data can't compute a next fire — disable loudly rather
		// than lease-spin forever.
		_ = q.DisableScheduleEntry(ctx, entry.ID)
		e.audit.Write(ctx, e.pool, &auth.Context{OrgID: entry.OrgID, UserID: "system:scheduler"},
			"schedule.entry.disabled", audit.Options{
				TargetType: "schedule_entry", TargetID: entry.ID,
				Metadata: map[string]any{"reason": "invalid_cron", "workflowId": entry.WorkflowID},
			})
		return false, nil
	}
	next, err := schedule.Next(now)
	if err != nil {
		_ = q.DisableScheduleEntry(ctx, entry.ID)
		return false, nil
	}
	// Advancing needs the current claim, so a stale holder never clears a newer one.
	advance := func(runID string) (bool, error) {
		rows, err := q.AdvanceScheduleEntry(ctx, store.AdvanceScheduleEntryParams{
			ID: entry.ID, NextFireAt: &next, LastRunAt: &now, LastRunID: runID, ClaimedDueAt: entry.ClaimedDueAt,
		})
		if err != nil {
			return false, fmt.Errorf("advance schedule entry %s: %w", entry.ID, err)
		}
		return rows > 0, nil
	}
	// The tick's identity is its LOGICAL due time, not this attempt: the
	// claim keeps the first claim's due time until the entry advances, so a
	// lease that expires mid-batch, a crash between the run insert and the
	// advance, or a second replica claiming the same entry resolve to one run.
	dueAt := now
	if entry.DueAt != nil {
		dueAt = entry.DueAt.UTC()
	}
	// Only the holder that advances the entry audits the drop, once per tick.
	drop := func(target, targetID string, metadata map[string]any) (bool, error) {
		advanced, err := advance("")
		if advanced {
			metadata["nodeId"], metadata["scheduledAt"] = entry.NodeID, dueAt.Format(time.RFC3339)
			e.audit.Write(ctx, e.pool, &auth.Context{OrgID: entry.OrgID, UserID: "system:scheduler"},
				"schedule.tick.dropped", audit.Options{TargetType: target, TargetID: targetID, Metadata: metadata})
		}
		return false, err
	}
	tick := entry.ID + "@" + dueAt.Format(time.RFC3339Nano)
	idempotencyKey := "schedule:" + tick

	// Active-parent guard: a stale entry must never re-run a tombstoned or
	// foreign workflow (delete the orphan entry), and a paused workflow
	// DROPS the tick loudly.
	owner, err := q.GetWorkflowIngestState(ctx, entry.WorkflowID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_ = q.DeleteScheduleEntry(ctx, entry.ID)
			return false, nil
		}
		return false, fmt.Errorf("read schedule owner %s: %w", entry.WorkflowID, err)
	}
	if owner.OrgID != entry.OrgID || owner.DeletedAt != nil {
		_ = q.DeleteScheduleEntry(ctx, entry.ID)
		return false, nil
	}
	// A retried tick whose run already started only records it; nothing below may drop it.
	if runID, err := q.GetStartIdempotencyRun(ctx, store.GetStartIdempotencyRunParams{
		OrgID: entry.OrgID, IdempotencyKey: idempotencyKey,
	}); err == nil {
		_, err := advance(runID)
		return false, err
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return false, fmt.Errorf("read schedule tick run %s: %w", entry.ID, err)
	}
	if owner.Status != "" && owner.Status != "active" {
		return drop("workflow", entry.WorkflowID, map[string]any{"reason": owner.Status})
	}

	parsed, err := loadWorkflowVersion(ctx, q, entry.OrgID, entry.WorkflowID, entry.WorkflowVersionID, versions)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = q.DeleteScheduleEntry(ctx, entry.ID)
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read schedule version %s: %w", entry.WorkflowVersionID, err)
	}
	wf := parsed.workflow
	if wf == nil {
		return drop("workflow", entry.WorkflowID, map[string]any{"reason": "version_unparseable", "versionId": entry.WorkflowVersionID})
	}
	if !hasScheduleNode(wf, entry.NodeID) {
		_ = q.DeleteScheduleEntry(ctx, entry.ID)
		return false, nil
	}

	start := StartInput{
		OrgID: entry.OrgID, Workflow: wf, WorkflowVersionID: entry.WorkflowVersionID,
		CreatedBy:      "system:scheduler",
		IdempotencyKey: idempotencyKey,
		Input: map[string]any{
			"triggeredBy": "schedule", "nodeId": entry.NodeID,
			"scheduledAt": dueAt.Format(time.RFC3339),
		},
	}
	// Ticks follow the deployment like every production start, keyed by the
	// tick so a retry lands on the same arm. A version the rollout cannot run
	// drops the tick loudly; a read failure retries it.
	assignment, err := e.resolveRolloutAssignment(ctx, entry.OrgID, entry.WorkflowID, tick, versions)
	var unavailable *RolloutVersionUnavailableError
	if errors.As(err, &unavailable) {
		return drop("workflow_rollout", unavailable.RolloutID, map[string]any{
			"reason": "rollout_version_unavailable", "workflowId": entry.WorkflowID, "versionId": unavailable.VersionID,
		})
	}
	if err != nil {
		return false, fmt.Errorf("resolve schedule rollout for %s: %w", entry.WorkflowID, err)
	}
	if assignment != nil {
		// Rollout creation requires identical trigger contracts; this keeps the tick from running an arm without its trigger.
		if !hasScheduleNode(assignment.Workflow, entry.NodeID) {
			return drop("workflow_rollout", assignment.Rollout.ID, map[string]any{
				"reason": "rollout_trigger_missing", "workflowId": entry.WorkflowID, "versionId": assignment.VersionID,
			})
		}
		start.Workflow, start.WorkflowVersionID = assignment.Workflow, assignment.VersionID
		start.WorkflowRolloutID, start.WorkflowRolloutVariant = assignment.Rollout.ID, assignment.Variant
	}
	runID, err := e.StartRun(ctx, start)
	if err != nil {
		var replay *ErrStartIdempotencyReplay
		if errors.As(err, &replay) {
			// Another holder started this tick between the replay check and here.
			_, err := advance(replay.RunID)
			return false, err
		}
		var invalid *InputValidationError
		if errors.As(err, &invalid) {
			return drop("workflow", entry.WorkflowID, map[string]any{"reason": "input_invalid"})
		}
		return false, fmt.Errorf("start scheduled run for %s: %w", entry.WorkflowID, err)
	}
	_, err = advance(runID)
	return true, err
}

func hasScheduleNode(wf *domain.Workflow, nodeID string) bool {
	for _, node := range wf.Nodes {
		if node.ID == nodeID && node.Type == "schedule" {
			return true
		}
	}
	return false
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
		fired, dropped, err := e.SweepDueSchedules(ctx)
		observability.ObserveSweepPass(observability.SweepSchedule, started, err)
		if fired > 0 || dropped > 0 {
			logger.Info("schedule sweep", "fired", fired, "dropped", dropped)
		}
	}
}
