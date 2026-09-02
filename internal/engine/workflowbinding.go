package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

// ErrWorkflowVersionBindingMismatch reports an explicit version claim that is
// missing, cross-tenant, belongs to another workflow, or does not contain the
// exact executable document submitted by the caller. Those cases deliberately
// share one error so a version id cannot become a tenant-enumeration oracle.
var ErrWorkflowVersionBindingMismatch = errors.New("workflow version binding mismatch")

// WorkflowVersionBinding identifies whether a submitted workflow is exactly a
// persisted immutable version. Unbound documents remain valid ad-hoc runs, but
// receive a run-scoped identity rather than pretending the workflow id is a
// version id.
type WorkflowVersionBinding struct {
	VersionID string
	Bound     bool
}

// ResolveWorkflowVersionBinding verifies an optional explicit version claim.
// Without a claim it opportunistically binds an exact copy of the latest saved
// version, which keeps older API/MCP clients honest without preventing edited
// drafts from running ad hoc. Explicit claims always fail closed on mismatch.
func (e *Engine) ResolveWorkflowVersionBinding(
	ctx context.Context,
	orgID string,
	workflow *domain.Workflow,
	requestedVersionID string,
) (WorkflowVersionBinding, error) {
	if e == nil || e.pool == nil || orgID == "" || workflow == nil {
		return WorkflowVersionBinding{}, fmt.Errorf("resolve workflow version binding: invalid input")
	}
	if workflow.ID == "" {
		if requestedVersionID != "" {
			return WorkflowVersionBinding{}, ErrWorkflowVersionBindingMismatch
		}
		return WorkflowVersionBinding{}, nil
	}

	q := store.New(e.pool)
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflow.ID, OrgID: orgID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if requestedVersionID != "" {
				return WorkflowVersionBinding{}, ErrWorkflowVersionBindingMismatch
			}
			return WorkflowVersionBinding{}, nil
		}
		return WorkflowVersionBinding{}, fmt.Errorf("read workflow parent for version binding: %w", err)
	}

	var versionID string
	var dagJSON []byte
	if requestedVersionID != "" {
		row, err := q.GetWorkflowVersionByID(ctx, store.GetWorkflowVersionByIDParams{
			ID: requestedVersionID, OrgID: orgID, WorkflowID: workflow.ID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return WorkflowVersionBinding{}, ErrWorkflowVersionBindingMismatch
			}
			return WorkflowVersionBinding{}, fmt.Errorf("read requested workflow version: %w", err)
		}
		versionID, dagJSON = row.ID, row.DagJson
	} else {
		row, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
			WorkflowID: workflow.ID, OrgID: orgID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return WorkflowVersionBinding{}, nil
			}
			return WorkflowVersionBinding{}, fmt.Errorf("read latest workflow version: %w", err)
		}
		versionID, dagJSON = row.ID, row.DagJson
	}

	matches, err := workflowDocumentsEqual(workflow, dagJSON)
	if err != nil {
		return WorkflowVersionBinding{}, fmt.Errorf("compare workflow version binding: %w", err)
	}
	if !matches {
		if requestedVersionID != "" {
			return WorkflowVersionBinding{}, ErrWorkflowVersionBindingMismatch
		}
		return WorkflowVersionBinding{}, nil
	}
	return WorkflowVersionBinding{VersionID: versionID, Bound: true}, nil
}

func workflowDocumentsEqual(submitted *domain.Workflow, persisted []byte) (bool, error) {
	stored, issues := domain.Parse(persisted)
	if stored == nil || len(issues) > 0 {
		return false, fmt.Errorf("persisted workflow version is invalid")
	}
	// Canvas coordinates are authoring metadata, not executable authority. The
	// browser may synthesize positions while hydrating an older version that did
	// not persist UI state, so comparing UI would falsely reject the exact DAG.
	submittedExecutable := *submitted
	submittedExecutable.UI = nil
	storedExecutable := *stored
	storedExecutable.UI = nil
	submittedJSON, err := domain.CanonicalWorkflowDocument(&submittedExecutable)
	if err != nil {
		return false, err
	}
	storedJSON, err := domain.CanonicalWorkflowDocument(&storedExecutable)
	if err != nil {
		return false, err
	}
	return bytes.Equal(submittedJSON, storedJSON), nil
}
