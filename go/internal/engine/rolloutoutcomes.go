// Rollout outcome receipts + automatic rollback (reference
// recordWorkflowRolloutOutcome): every terminal PRODUCTION run under an
// active rollout writes one idempotent receipt (PK run_id, ON CONFLICT
// DO NOTHING) and bumps the aggregate counters in the SAME transaction;
// when the canary reaches the minimum sample below the minimum success
// rate, the auto-rollback CAS fires atomically with its system audit
// evidence. Once a rollout finishes (operator or guardrail), later
// terminal arrivals deliberately cannot alter its frozen evidence. A
// bounded repair pass re-drives receipts missed by a crash window.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/store"
)

// RecordWorkflowRolloutOutcome records one terminal production outcome.
// Returns "recorded", "duplicate", or "ignored".
func (e *Engine) RecordWorkflowRolloutOutcome(ctx context.Context, runID string) (string, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))

	run, err := q.GetRunForRolloutOutcome(ctx, runID)
	if err != nil {
		return "ignored", nil //nolint:nilerr // a missing run is not an outcome
	}
	status := run.Status
	if !run.WorkflowRolloutID.Valid || !run.WorkflowRolloutVariant.Valid || run.ReplayMode.Valid {
		return "ignored", nil
	}
	if status != "succeeded" && status != "failed" && status != "cancelled" {
		return "ignored", nil
	}
	rollout, err := q.GetActiveRolloutForOutcome(ctx, store.GetActiveRolloutForOutcomeParams{
		ID: run.WorkflowRolloutID.String, OrgID: run.OrgID,
	})
	if err != nil {
		return "ignored", nil //nolint:nilerr // finished rollouts keep frozen evidence
	}
	variant := run.WorkflowRolloutVariant.String
	expectedVersion := rollout.BaselineVersionID
	if variant == "canary" {
		expectedVersion = rollout.CanaryVersionID
	}
	if run.WorkflowVersionID != expectedVersion {
		return "ignored", nil
	}
	inserted, err := q.InsertWorkflowRolloutOutcome(ctx, store.InsertWorkflowRolloutOutcomeParams{
		RunID: runID, OrgID: run.OrgID, RolloutID: rollout.ID,
		WorkflowID: rollout.WorkflowID, Variant: variant, Status: status,
	})
	if err != nil {
		return "", err
	}
	if inserted == 0 {
		return "duplicate", nil
	}
	increments := store.IncrementRolloutCountersParams{ID: rollout.ID}
	if status != "cancelled" {
		switch {
		case variant == "canary" && status == "succeeded":
			increments.CanarySucceededInc = 1
		case variant == "canary":
			increments.CanaryFailedInc = 1
		case status == "succeeded":
			increments.BaselineSucceededInc = 1
		default:
			increments.BaselineFailedInc = 1
		}
	}
	updated, err := q.IncrementRolloutCounters(ctx, increments)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "ignored", nil
		}
		return "", err
	}

	canarySample := updated.CanarySucceeded + updated.CanaryFailed
	canarySuccessRate := 100.0
	if canarySample > 0 {
		canarySuccessRate = float64(updated.CanarySucceeded) / float64(canarySample) * 100
	}
	shouldRollback := variant == "canary" && status != "cancelled" &&
		canarySample >= updated.MinimumSampleSize &&
		canarySuccessRate < float64(updated.MinimumSuccessRatePercent)
	if shouldRollback {
		reason := "canary_success_rate_breach"
		rolledBack, err := q.AutoRollbackRollout(ctx, store.AutoRollbackRolloutParams{
			ID: rollout.ID, Reason: pgtype.Text{String: reason, Valid: true},
		})
		if err == nil {
			metadata, _ := json.Marshal(map[string]any{
				"workflowId":        rolledBack.WorkflowID,
				"baselineVersionId": rolledBack.BaselineVersionID,
				"canaryVersionId":   rolledBack.CanaryVersionID,
				"canarySucceeded":   rolledBack.CanarySucceeded, "canaryFailed": rolledBack.CanaryFailed,
				"minimumSampleSize":          rolledBack.MinimumSampleSize,
				"minimumSuccessRatePercent":  rolledBack.MinimumSuccessRatePercent,
				"observedSuccessRatePercent": canarySuccessRate,
				"reason":                     reason,
			})
			if err := q.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
				ID: e.newID(), OrgID: rolledBack.OrgID,
				UserID:     pgtype.Text{String: "rollout-guardrail", Valid: true},
				Action:     "workflow.rollout.auto_rolled_back",
				TargetType: pgtype.Text{String: "workflow_rollout", Valid: true},
				TargetID:   pgtype.Text{String: rolledBack.ID, Valid: true},
				Metadata:   metadata,
			}); err != nil {
				return "", err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return "recorded", nil
}

// maybeRecordRolloutOutcome is the post-commit best-effort hook on both
// terminal paths — the receipt transaction itself re-validates
// everything, and the bounded repair covers crash windows.
func (e *Engine) maybeRecordRolloutOutcome(ctx context.Context, runID string) {
	if _, err := e.RecordWorkflowRolloutOutcome(ctx, runID); err != nil {
		slog.Warn("[rollout] outcome record failed", "runId", runID, "error", err)
	}
}

// RepairWorkflowRolloutOutcomes re-drives bounded missing receipts for
// ACTIVE rollouts only (frozen evidence stays frozen). Returns repaired.
func (e *Engine) RepairWorkflowRolloutOutcomes(ctx context.Context, limit int) int {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := store.New(e.pool).ListUnrecordedRolloutOutcomes(ctx, int32(limit))
	if err != nil {
		return 0
	}
	repaired := 0
	for _, row := range rows {
		if outcome, err := e.RecordWorkflowRolloutOutcome(ctx, row.RunID); err == nil && outcome == "recorded" {
			repaired++
		}
	}
	return repaired
}
