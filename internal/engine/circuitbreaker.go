// Circuit-breaker persistence: the trip at the terminal-failure site and
// the deliberately MANUAL resume with its oldest-first buffered backfill.
// The decision layer is pure (internal/recovery); this file owns the CAS
// on the existing pause substrate (workflows.status + paused_reason) and
// the exactly-once announcement — the flip and its audit commit together,
// because a pause with no human in the loop that the trail can't explain
// leaves the operator with a stopped workflow and no record of why.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

// maybeTripCircuitBreaker evaluates the streak after one terminal run
// failure. Best-effort by contract: the dead letter is already durable,
// so a breaker fault logs and returns — it must never break the DLQ path.
func (e *Engine) maybeTripCircuitBreaker(ctx context.Context, orgID, workflowID string, runID string) {
	if workflowID == "" || !recovery.IsCircuitBreakerEnabled() {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("[circuit-breaker] evaluation panicked", "workflowId", workflowID)
		}
	}()
	q := store.New(e.pool)

	status, err := q.GetWorkflowBreakerStatus(ctx, store.GetWorkflowBreakerStatusParams{
		OrgID: orgID, ID: workflowID,
	})
	if err != nil {
		return // ad-hoc / deleted: nothing to pause
	}
	// Resolve the workflow knob from the latest version snapshot via the
	// run's own workflow (the caller passes runID for the audit only; the
	// knob rides the run input snapshot read below).
	var workflowKnob []byte
	if run, err := q.GetRunExecution(ctx, runID); err == nil {
		var envelope struct {
			Workflow struct {
				Recovery struct {
					CircuitBreaker json.RawMessage `json:"circuitBreaker"`
				} `json:"recovery"`
			} `json:"workflow"`
		}
		if json.Unmarshal(run.InputJson, &envelope) == nil {
			workflowKnob = envelope.Workflow.Recovery.CircuitBreaker
		}
	}
	threshold := resolveBreakerThreshold(ctx, e, orgID, workflowKnob)
	if threshold <= 0 {
		return
	}

	statuses, err := q.CountRecentWorkflowRunStatuses(ctx, store.CountRecentWorkflowRunStatusesParams{
		OrgID: orgID, WorkflowID: workflowID, PageLimit: int32(threshold),
	})
	if err != nil {
		return
	}
	streak := 0
	for _, s := range statuses {
		if s != "failed" {
			break
		}
		streak++
	}
	if !recovery.ShouldTripCircuitBreaker(streak, threshold, status) {
		return
	}

	reason := fmt.Sprintf("Circuit breaker: %d consecutive failed runs", streak)
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(tx)
	tripped, err := txq.TripWorkflowCircuitBreaker(ctx, store.TripWorkflowCircuitBreakerParams{
		OrgID: orgID, ID: workflowID, Reason: pgtype.Text{String: reason, Valid: true},
	})
	if err != nil || tripped == 0 {
		// The CAS lost — a concurrent worker racing the same streak owns
		// the announcement; duplicate pages must not fan out.
		return
	}
	metadata, _ := json.Marshal(map[string]any{
		"reason": reason, "consecutiveFailures": streak, "threshold": threshold, "runId": runID,
	})
	if err := txq.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: e.newID(), OrgID: orgID,
		UserID:     pgtype.Text{String: "circuit-breaker", Valid: true},
		Action:     "workflow.circuit_breaker.tripped",
		TargetType: pgtype.Text{String: "workflow", Valid: true},
		TargetID:   pgtype.Text{String: workflowID, Valid: true},
		Metadata:   metadata,
	}); err != nil {
		return
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	slog.Error("[circuit-breaker] workflow paused",
		"orgId", orgID, "workflowId", workflowID, "consecutiveFailures", streak, "threshold", threshold)
	// Alert producer (post-commit; the trip CAS already deduped announcers).
	e.DispatchAlert(ctx, orgID, "workflow.circuit_breaker_tripped", map[string]any{
		"workflowId": workflowID, "consecutiveFailures": streak, "threshold": threshold,
		"runId": runID, "dedupeKey": "breaker:" + workflowID,
	})
}

func resolveBreakerThreshold(ctx context.Context, e *Engine, orgID string, workflowKnob []byte) int {
	if len(workflowKnob) > 0 {
		threshold, on, problem := parseBreakerKnob(workflowKnob)
		if problem == "" {
			if !on {
				return 0
			}
			return threshold
		}
	}
	orgThreshold := orgconfig.LoadNumber(ctx, e.pool, orgID, "runs.circuitBreakerThreshold")
	if orgThreshold >= 2 && orgThreshold <= 100 {
		return int(orgThreshold)
	}
	return recovery.DefaultCircuitBreakerThreshold
}

// parseBreakerKnob defers to the domain union parser.
func parseBreakerKnob(raw []byte) (int, bool, string) {
	return domain.ParseCircuitBreakerThreshold(raw)
}

// ErrWorkflowNotResumable reports a resume against a pause that clears on
// its own, such as an upstream outage.
type ErrWorkflowNotResumable struct{ Status string }

func (e *ErrWorkflowNotResumable) Error() string {
	return "workflow pause clears on its own (status: " + e.Status + ")"
}

// handOverToUpstreamPause replaces a manual pause with the upstream pause it
// was hiding, so the poller resumes the workflow when the upstream recovers.
func (e *Engine) handOverToUpstreamPause(ctx context.Context, tx pgx.Tx, txq *store.Queries,
	orgID, workflowID, userID string, degraded store.GetDegradedUpstreamForWorkflowRow) error {
	if err := txq.SetWorkflowPauseState(ctx, store.SetWorkflowPauseStateParams{
		OrgID: orgID, ID: workflowID, Status: upstreamPausedStatus,
		PausedReason: pgtype.Text{String: "Upstream \"" + degraded.Name + "\" degraded (" + degraded.LastStatus + ")", Valid: true},
	}); err != nil {
		return fmt.Errorf("upstream hand-over: %w", err)
	}
	metadata, _ := json.Marshal(map[string]any{"via": "operator_resume", "sourceName": degraded.Name, "status": degraded.LastStatus})
	if err := txq.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: e.newID(), OrgID: orgID,
		UserID:     pgtype.Text{String: userID, Valid: userID != ""},
		Action:     "workflow.paused.upstream",
		TargetType: pgtype.Text{String: "workflow", Valid: true},
		TargetID:   pgtype.Text{String: workflowID, Valid: true},
		Metadata:   metadata,
	}); err != nil {
		return fmt.Errorf("audit upstream hand-over: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit upstream hand-over: %w", err)
	}
	return &ErrWorkflowNotResumable{Status: upstreamPausedStatus}
}

const upstreamPausedStatus = "paused_upstream_degraded"

// ErrWorkflowNotFoundForResume covers absent/tombstoned workflows.
var ErrWorkflowNotFoundForResume = errors.New("workflow not found")

// BackfillOutcome summarizes one resume's buffered drain.
type BackfillOutcome struct {
	Backfilled int `json:"backfilled"`
	Failed     int `json:"failed"`
	Remaining  int `json:"remaining"`
}

// backfillPageLimit bounds one resume call's drain; repeated calls drain
// the next page (the contract's capped-window posture).
const backfillPageLimit = 50

// ResumeWorkflow lifts a manual or circuit-breaker pause and then drains the
// buffered trigger events oldest-first. It returns the status it lifted, or
// "" when the workflow was already active. A breaker resume is audited in the
// same transaction; the caller audits a manual resume. The backfill never
// fails the resume: the workflow is active by then.
func (e *Engine) ResumeWorkflow(ctx context.Context, orgID, workflowID, userID string) (BackfillOutcome, string, error) {
	outcome := BackfillOutcome{}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return outcome, "", fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(tx)
	status, err := txq.LockWorkflowPauseState(ctx, store.LockWorkflowPauseStateParams{OrgID: orgID, ID: workflowID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return outcome, "", ErrWorkflowNotFoundForResume
		}
		return outcome, "", fmt.Errorf("lock status: %w", err)
	}
	lifted := ""
	switch status {
	case "active":
		// A previous resume may have left a capped buffered window.
	case WorkflowStatusPausedManual, recovery.WorkflowStatusPausedCircuitBreaker:
		if status == WorkflowStatusPausedManual {
			degraded, err := txq.GetDegradedUpstreamForWorkflow(ctx, store.GetDegradedUpstreamForWorkflowParams{
				OrgID: orgID, WorkflowID: workflowID,
			})
			switch {
			case err == nil:
				return outcome, "", e.handOverToUpstreamPause(ctx, tx, txq, orgID, workflowID, userID, degraded)
			case !errors.Is(err, pgx.ErrNoRows):
				return outcome, "", fmt.Errorf("read upstream state: %w", err)
			}
		}
		if err := txq.SetWorkflowPauseState(ctx, store.SetWorkflowPauseStateParams{
			OrgID: orgID, ID: workflowID, Status: "active",
		}); err != nil {
			return outcome, "", fmt.Errorf("resume flip: %w", err)
		}
		if status == recovery.WorkflowStatusPausedCircuitBreaker {
			metadata, _ := json.Marshal(map[string]any{"via": "operator_resume"})
			if err := txq.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
				ID: e.newID(), OrgID: orgID,
				UserID:     pgtype.Text{String: userID, Valid: userID != ""},
				Action:     "workflow.circuit_breaker.resumed",
				TargetType: pgtype.Text{String: "workflow", Valid: true},
				TargetID:   pgtype.Text{String: workflowID, Valid: true},
				Metadata:   metadata,
			}); err != nil {
				return outcome, "", fmt.Errorf("audit resume: %w", err)
			}
		}
		lifted = status
	default:
		return outcome, "", &ErrWorkflowNotResumable{Status: status}
	}
	if err := tx.Commit(ctx); err != nil {
		return outcome, "", fmt.Errorf("commit resume: %w", err)
	}
	outcome = e.backfillBufferedTriggerEvents(ctx, orgID, workflowID, userID)
	return outcome, lifted, nil
}

// backfillBufferedTriggerEvents claims a bounded oldest-first page of
// buffered events and starts each one through the ordinary trigger-start
// machinery (the trigger-event CAS makes a double backfill impossible).
func (e *Engine) backfillBufferedTriggerEvents(ctx context.Context, orgID, workflowID, userID string) BackfillOutcome {
	outcome := BackfillOutcome{}
	q := store.New(e.pool)
	claimed, err := q.ClaimBufferedTriggerEvents(ctx, store.ClaimBufferedTriggerEventsParams{
		OrgID: orgID, WorkflowID: pgtype.Text{String: workflowID, Valid: true},
		ClaimToken: pgtype.Text{String: e.newID(), Valid: true},
		PageLimit:  backfillPageLimit,
	})
	if err != nil {
		return outcome
	}
	// The workflow snapshot: latest version of the workflow.
	version, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
		WorkflowID: workflowID, OrgID: orgID,
	})
	if err != nil {
		outcome.Failed = len(claimed)
		return outcome
	}
	wf, issues := domain.Parse(version.DagJson)
	if wf == nil {
		slog.Warn("[circuit-breaker] backfill snapshot invalid", "workflowId", workflowID, "issues", issues)
		outcome.Failed = len(claimed)
		return outcome
	}
	for _, event := range claimed {
		// The persisted anchor wraps the inbound event as {"event": {...}};
		// unwrap so the backfilled run's input matches the ordinary ingest
		// shape exactly ({triggeredBy, triggerEventId, event}).
		var envelope struct {
			Event map[string]any `json:"event"`
		}
		_ = json.Unmarshal(event.PayloadJson, &envelope)
		input := map[string]any{
			"triggeredBy": "webhook_received", "triggerEventId": event.ID,
			"event":      envelope.Event,
			"backfilled": true,
		}
		// A buffered event that captured a rollout assignment at ACCEPT
		// time keeps it: the backfilled run executes the CAPTURED variant
		// snapshot, never a version the mutable rollout points at today.
		eventWorkflow, eventVersionID := wf, version.ID
		start := StartInput{
			OrgID: orgID, Workflow: eventWorkflow, WorkflowVersionID: eventVersionID,
			Input: input, CreatedBy: userID, TriggerEventID: event.ID,
		}
		if event.WorkflowRolloutID.Valid && event.WorkflowRolloutVariant.Valid {
			if captured, err := q.GetWorkflowVersionAnyWorkflow(ctx, store.GetWorkflowVersionAnyWorkflowParams{
				ID: event.WorkflowVersionID, OrgID: orgID,
			}); err == nil {
				if capturedWf, _ := domain.Parse(captured.DagJson); capturedWf != nil {
					start.Workflow = capturedWf
					start.WorkflowVersionID = event.WorkflowVersionID
					start.WorkflowRolloutID = event.WorkflowRolloutID.String
					start.WorkflowRolloutVariant = event.WorkflowRolloutVariant.String
				}
			}
		}
		_, err := e.StartRun(ctx, start)
		if err != nil {
			var conflict *TriggerEventStartConflictError
			if errors.As(err, &conflict) {
				// Another actor consumed the event — not a failure.
				continue
			}
			outcome.Failed++
			continue
		}
		outcome.Backfilled++
	}
	if remaining, err := q.CountBufferedTriggerEvents(ctx, store.CountBufferedTriggerEventsParams{
		OrgID: orgID, WorkflowID: pgtype.Text{String: workflowID, Valid: true},
	}); err == nil {
		outcome.Remaining = int(remaining)
	}
	return outcome
}
