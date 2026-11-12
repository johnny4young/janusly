package engine

import (
	"context"
	"errors"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

var (
	ErrWorkflowLifecycleNotFound   = errors.New("workflow not found")
	ErrRollbackSourceNotFound      = errors.New("source version not found")
	ErrWorkflowVersionMalformed    = errors.New("workflow version is malformed")
	ErrWorkflowRollbackRolloutLive = errors.New("workflow rollout is active")
	ErrWorkflowRollbackConflict    = errors.New("concurrent workflow rollback conflict")
)

type RollbackWorkflowInput struct {
	OrgID, UserID, WorkflowID, SourceVersionID string
	NewID                                      func() string
}

type RollbackWorkflowResult struct {
	VersionID     string
	Version       int32
	SourceVersion int32
	Attempts      int
}

// RollbackWorkflowVersion appends an older immutable version as the new latest
// one, keeping the latest version's reliability settings and reconciling
// schedules. API and MCP share it so both write the same history.
func (e *Engine) RollbackWorkflowVersion(ctx context.Context, input RollbackWorkflowInput) (RollbackWorkflowResult, error) {
	newID := input.NewID
	if newID == nil {
		newID = e.newID
	}
	if e == nil || e.pool == nil || newID == nil || input.OrgID == "" {
		return RollbackWorkflowResult{}, errors.New("workflow rollback dependencies are unavailable")
	}
	for attempt := 1; attempt <= WorkflowVersionWriteAttempts; attempt++ {
		result, err := e.rollbackWorkflowVersionAttempt(ctx, input, newID)
		if err == nil {
			result.Attempts = attempt
			return result, nil
		}
		if !retryableWorkflowSave(err) {
			return RollbackWorkflowResult{}, err
		}
	}
	return RollbackWorkflowResult{}, ErrWorkflowRollbackConflict
}

func (e *Engine) rollbackWorkflowVersionAttempt(
	ctx context.Context, input RollbackWorkflowInput, newID func() string,
) (RollbackWorkflowResult, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return RollbackWorkflowResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	if _, err := q.LockWorkflowForRollout(ctx, store.LockWorkflowForRolloutParams{
		OrgID: input.OrgID, ID: input.WorkflowID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RollbackWorkflowResult{}, ErrWorkflowLifecycleNotFound
		}
		return RollbackWorkflowResult{}, err
	}
	if _, err := q.FindActiveWorkflowRollout(ctx, store.FindActiveWorkflowRolloutParams{
		OrgID: input.OrgID, WorkflowID: input.WorkflowID,
	}); err == nil {
		return RollbackWorkflowResult{}, ErrWorkflowRollbackRolloutLive
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return RollbackWorkflowResult{}, err
	}
	source, err := q.GetWorkflowVersionByID(ctx, store.GetWorkflowVersionByIDParams{
		ID: input.SourceVersionID, OrgID: input.OrgID, WorkflowID: input.WorkflowID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RollbackWorkflowResult{}, ErrRollbackSourceNotFound
		}
		return RollbackWorkflowResult{}, err
	}
	wf, _ := domain.Parse(source.DagJson)
	if wf == nil {
		return RollbackWorkflowResult{}, ErrWorkflowVersionMalformed
	}
	canonicalSource, err := domain.CanonicalWorkflowDocument(wf)
	if err != nil {
		return RollbackWorkflowResult{}, err
	}
	latest, err := q.GetLatestWorkflowVersionReliability(ctx, store.GetLatestWorkflowVersionReliabilityParams{
		WorkflowID: input.WorkflowID, OrgID: input.OrgID,
	})
	if err != nil {
		return RollbackWorkflowResult{}, err
	}
	versionID := newID()
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: input.OrgID, WorkflowID: input.WorkflowID,
		Version: latest.Version + 1, DagJson: canonicalSource,
		CreatedBy:             pgtype.Text{String: input.UserID, Valid: input.UserID != ""},
		SloJson:               latest.SloJson,
		UpstreamHealthSources: latest.UpstreamHealthSources,
	}); err != nil {
		return RollbackWorkflowResult{}, err
	}
	if err := e.SyncWorkflowSchedules(ctx, q, input.OrgID, input.WorkflowID, versionID, input.UserID, wf); err != nil {
		return RollbackWorkflowResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RollbackWorkflowResult{}, err
	}
	return RollbackWorkflowResult{VersionID: versionID, Version: latest.Version + 1, SourceVersion: source.Version}, nil
}

// DeactivateWorkflow tombstones a workflow, cancels its active rollout and
// removes its schedule entries in one transaction, so nothing fires after it.
func (e *Engine) DeactivateWorkflow(ctx context.Context, orgID, workflowID string) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	rows, err := q.SoftDeleteWorkflow(ctx, store.SoftDeleteWorkflowParams{ID: workflowID, OrgID: orgID})
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrWorkflowLifecycleNotFound
	}
	if _, err := q.CancelActiveWorkflowRollout(ctx, store.CancelActiveWorkflowRolloutParams{
		OrgID: orgID, WorkflowID: workflowID, Reason: pgtype.Text{String: "workflow_deleted", Valid: true},
	}); err != nil {
		return err
	}
	if err := q.DeleteScheduleEntriesForWorkflow(ctx, store.DeleteScheduleEntriesForWorkflowParams{
		OrgID: orgID, WorkflowID: workflowID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReactivateWorkflow restores a tombstoned workflow and rebuilds its schedules
// from the latest version in the same transaction.
func (e *Engine) ReactivateWorkflow(ctx context.Context, orgID, workflowID, userID string) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	rows, err := q.RestoreWorkflow(ctx, store.RestoreWorkflowParams{ID: workflowID, OrgID: orgID})
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrWorkflowLifecycleNotFound
	}
	version, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{WorkflowID: workflowID, OrgID: orgID})
	switch {
	case err == nil:
		wf, _ := domain.Parse(version.DagJson)
		if wf == nil {
			return ErrWorkflowVersionMalformed
		}
		if err := e.SyncWorkflowSchedules(ctx, q, orgID, workflowID, version.ID, userID, wf); err != nil {
			return err
		}
	case errors.Is(err, pgx.ErrNoRows):
		// A workflow created before its first save has no schedules to restore.
	default:
		return err
	}
	return tx.Commit(ctx)
}

// WorkflowStatusPausedManual is a pause a person or agent asked for. Only an
// explicit resume lifts it; automatic resumes match their own status.
const WorkflowStatusPausedManual = "paused_manual"

// MaxPauseReasonRunes bounds the operator's pause reason.
const MaxPauseReasonRunes = 500

// PauseOutcome is what a pause found and left.
type PauseOutcome struct {
	Previous, Status, Reason string
}

// PauseWorkflow stops new runs without touching versions, schedule entries or
// rollouts: schedule ticks are dropped and trigger events are buffered until
// ResumeWorkflow. A manual pause replaces a system pause so that no automatic
// resume lifts it, except a circuit-breaker pause, which only a person lifts.
// It returns the status it found, the status the workflow now has and the
// reason it stored after sanitizing; a pause that changes nothing stores none.
func (e *Engine) PauseWorkflow(ctx context.Context, orgID, workflowID, reason string) (PauseOutcome, error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return PauseOutcome{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))
	status, err := q.LockWorkflowPauseState(ctx, store.LockWorkflowPauseStateParams{OrgID: orgID, ID: workflowID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PauseOutcome{}, ErrWorkflowLifecycleNotFound
		}
		return PauseOutcome{}, err
	}
	if status == WorkflowStatusPausedManual || status == recovery.WorkflowStatusPausedCircuitBreaker {
		return PauseOutcome{Previous: status, Status: status}, nil
	}
	reason = sanitizePauseReason(reason)
	if err := q.SetWorkflowPauseState(ctx, store.SetWorkflowPauseStateParams{
		OrgID: orgID, ID: workflowID, Status: WorkflowStatusPausedManual,
		PausedReason: pgtype.Text{String: reason, Valid: reason != ""},
	}); err != nil {
		return PauseOutcome{}, err
	}
	return PauseOutcome{Previous: status, Status: WorkflowStatusPausedManual, Reason: reason}, tx.Commit(ctx)
}

// sanitizePauseReason keeps the reason one bounded line without secret-shaped
// literals; every viewer of the workflow list sees it.
func sanitizePauseReason(reason string) string {
	reason = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, signature.ScrubSecretShapes(reason))
	reason = strings.Join(strings.Fields(reason), " ")
	if runes := []rune(reason); len(runes) > MaxPauseReasonRunes {
		reason = string(runes[:MaxPauseReasonRunes])
	}
	return reason
}
