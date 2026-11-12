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
	// ExpectedBaseVersionID, when set, makes the save fail with
	// ErrWorkflowSaveBaseMoved unless the latest version is still this one
	// ("" means none), checked under the workflow lock.
	ExpectedBaseVersionID *string
}

// ErrWorkflowSaveBaseMoved rejects a save built on a version that is no
// longer the latest.
var ErrWorkflowSaveBaseMoved = errors.New("workflow gained a version since the expected base")

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
		if err := ownedWorkflowAbsent(ctx, q, input.OrgID, input.Workflow.ID); err != nil {
			return SaveWorkflowVersionResult{}, err
		}
		inserted, err := q.InsertWorkflowIfAbsent(ctx, store.InsertWorkflowIfAbsentParams{
			ID: input.Workflow.ID, OrgID: input.OrgID, Name: input.Workflow.Name,
			CreatedBy: pgtype.Text{String: input.UserID, Valid: input.UserID != ""},
		})
		if err != nil {
			return SaveWorkflowVersionResult{}, err
		}
		if inserted == 0 {
			// Either this organization created it concurrently, or the id is another's.
			if err := ownedWorkflowAbsent(ctx, q, input.OrgID, input.Workflow.ID); err != nil {
				return SaveWorkflowVersionResult{}, err
			}
			return SaveWorkflowVersionResult{}, ErrWorkflowSaveIDTaken
		}
	default:
		return SaveWorkflowVersionResult{}, err
	}

	if input.ExpectedBaseVersionID != nil {
		current := ""
		latest, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
			WorkflowID: input.Workflow.ID, OrgID: input.OrgID,
		})
		switch {
		case err == nil:
			current = latest.ID
		case !errors.Is(err, pgx.ErrNoRows):
			return SaveWorkflowVersionResult{}, err
		}
		if current != *input.ExpectedBaseVersionID {
			return SaveWorkflowVersionResult{}, ErrWorkflowSaveBaseMoved
		}
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

// ownedWorkflowAbsent is nil when the organization has no row for the id: a
// tombstoned row answers not found, and a live one a concurrent create to retry.
func ownedWorkflowAbsent(ctx context.Context, q *store.Queries, orgID, workflowID string) error {
	deletedAt, err := q.GetWorkflowOwnerState(ctx, store.GetWorkflowOwnerStateParams{OrgID: orgID, ID: workflowID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil
	case err != nil:
		return err
	case deletedAt != nil:
		return ErrWorkflowSaveNotFound
	default:
		return errWorkflowSaveRetry
	}
}
