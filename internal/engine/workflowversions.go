package engine

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

// WorkflowVersionWriteAttempts is the bounded retry ceiling exposed to
// transport error envelopes and qualification evidence.
const WorkflowVersionWriteAttempts = 3

var (
	ErrWorkflowSaveNotFound      = errors.New("workflow not found")
	ErrWorkflowSaveIDTaken       = errors.New("workflow id is already taken")
	ErrWorkflowSaveRolloutActive = errors.New("workflow rollout is active")
	ErrWorkflowSaveConflict      = errors.New("concurrent workflow save conflict")
	errWorkflowSaveRetry         = errors.New("retry workflow save")
)

// SaveWorkflowVersionInput is the transport-neutral append contract used by
// HTTP and MCP. The engine owns canonicalization, parent locking, reliability
// inheritance, schedule reconciliation and commit ordering.
type SaveWorkflowVersionInput struct {
	OrgID                         string
	UserID                        string
	Workflow                      *domain.Workflow
	UpstreamHealthSources         json.RawMessage
	UpstreamHealthSourcesProvided bool
	NewID                         func() string
}

type SaveWorkflowVersionResult struct {
	VersionID string
	Version   int32
	Attempts  int
}

// SaveWorkflowVersion appends one immutable workflow version atomically. A
// single parent-row lock serializes every transport against saves, rollbacks,
// rollout creation, SLO changes and schedule reconciliation.
func (e *Engine) SaveWorkflowVersion(
	ctx context.Context,
	input SaveWorkflowVersionInput,
) (SaveWorkflowVersionResult, error) {
	if e == nil || e.pool == nil || input.Workflow == nil || input.OrgID == "" || input.Workflow.ID == "" {
		return SaveWorkflowVersionResult{}, errors.New("workflow save dependencies are unavailable")
	}
	dagJSON, err := domain.CanonicalWorkflowDocument(input.Workflow)
	if err != nil {
		return SaveWorkflowVersionResult{}, err
	}
	for attempt := 1; attempt <= WorkflowVersionWriteAttempts; attempt++ {
		result, err := e.saveWorkflowVersionAttempt(ctx, input, dagJSON, attempt)
		if err == nil {
			return result, nil
		}
		if retryableWorkflowSave(err) && attempt < WorkflowVersionWriteAttempts {
			continue
		}
		if retryableWorkflowSave(err) {
			return SaveWorkflowVersionResult{}, ErrWorkflowSaveConflict
		}
		return SaveWorkflowVersionResult{}, err
	}
	return SaveWorkflowVersionResult{}, ErrWorkflowSaveConflict
}

func (e *Engine) saveWorkflowVersionAttempt(
	ctx context.Context,
	input SaveWorkflowVersionInput,
	dagJSON json.RawMessage,
	attempt int,
) (SaveWorkflowVersionResult, error) {
	newID := input.NewID
	if newID == nil {
		newID = e.newID
	}
	if newID == nil {
		return SaveWorkflowVersionResult{}, errors.New("workflow save id generator is unavailable")
	}

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return SaveWorkflowVersionResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(e.wrapTx(tx))

	_, err = q.GetWorkflow(ctx, store.GetWorkflowParams{ID: input.Workflow.ID, OrgID: input.OrgID})
	switch {
	case err == nil:
		if _, err := q.LockWorkflowForRollout(ctx, store.LockWorkflowForRolloutParams{
			OrgID: input.OrgID, ID: input.Workflow.ID,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return SaveWorkflowVersionResult{}, ErrWorkflowSaveNotFound
			}
			return SaveWorkflowVersionResult{}, err
		}
		if err := q.UpdateWorkflowName(ctx, store.UpdateWorkflowNameParams{
			ID: input.Workflow.ID, OrgID: input.OrgID, Name: input.Workflow.Name,
		}); err != nil {
			return SaveWorkflowVersionResult{}, err
		}
	case errors.Is(err, pgx.ErrNoRows):
		owner, ownerErr := q.GetWorkflowOwnerState(ctx, input.Workflow.ID)
		if ownerErr == nil {
			if owner.OrgID == input.OrgID && owner.DeletedAt != nil {
				return SaveWorkflowVersionResult{}, ErrWorkflowSaveNotFound
			}
			if owner.OrgID != input.OrgID {
				return SaveWorkflowVersionResult{}, ErrWorkflowSaveIDTaken
			}
			return SaveWorkflowVersionResult{}, errWorkflowSaveRetry
		}
		if !errors.Is(ownerErr, pgx.ErrNoRows) {
			return SaveWorkflowVersionResult{}, ownerErr
		}
		if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{
			ID: input.Workflow.ID, OrgID: input.OrgID, Name: input.Workflow.Name,
			CreatedBy: pgtype.Text{String: input.UserID, Valid: input.UserID != ""},
		}); err != nil {
			return SaveWorkflowVersionResult{}, err
		}
	default:
		return SaveWorkflowVersionResult{}, err
	}

	if _, err := q.FindActiveWorkflowRollout(ctx, store.FindActiveWorkflowRolloutParams{
		OrgID: input.OrgID, WorkflowID: input.Workflow.ID,
	}); err == nil {
		return SaveWorkflowVersionResult{}, ErrWorkflowSaveRolloutActive
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return SaveWorkflowVersionResult{}, err
	}

	version := int32(0)
	var resolvedSLO json.RawMessage
	resolvedUpstream := input.UpstreamHealthSources
	latest, err := q.GetLatestWorkflowVersionReliability(ctx, store.GetLatestWorkflowVersionReliabilityParams{
		WorkflowID: input.Workflow.ID, OrgID: input.OrgID,
	})
	if err == nil {
		version = latest.Version
		resolvedSLO = latest.SloJson
		if !input.UpstreamHealthSourcesProvided {
			resolvedUpstream = latest.UpstreamHealthSources
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return SaveWorkflowVersionResult{}, err
	}

	versionID := newID()
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: input.OrgID, WorkflowID: input.Workflow.ID,
		Version: version + 1, DagJson: dagJSON,
		CreatedBy:             pgtype.Text{String: input.UserID, Valid: input.UserID != ""},
		UpstreamHealthSources: resolvedUpstream,
		SloJson:               resolvedSLO,
	}); err != nil {
		return SaveWorkflowVersionResult{}, err
	}
	if err := e.SyncWorkflowSchedules(
		ctx, q, input.OrgID, input.Workflow.ID, versionID, input.UserID, input.Workflow,
	); err != nil {
		return SaveWorkflowVersionResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SaveWorkflowVersionResult{}, err
	}
	return SaveWorkflowVersionResult{VersionID: versionID, Version: version + 1, Attempts: attempt}, nil
}

func retryableWorkflowSave(err error) bool {
	if errors.Is(err, errWorkflowSaveRetry) {
		return true
	}
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23505" {
		return false
	}
	return postgresError.ConstraintName == "workflow_versions_org_workflow_version_idx" ||
		postgresError.ConstraintName == "workflows_pkey"
}
