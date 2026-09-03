// Workflow lifecycle handlers: save (with the upstream-health carrier),
// list/latest/versions reads, rollback, and circuit-breaker resume. The
// contract and dual-run suites guard the preserved wire behavior.
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

func (s *V1Server) saveWorkflow(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.saveCore(r, rc))
}

func (s *V1Server) saveCore(r *http.Request, rc v1Request) opResult {

	var raw json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	var rawDocument map[string]json.RawMessage
	_ = json.Unmarshal(raw, &rawDocument)
	if field := unknownWorkflowSaveField(rawDocument); field != "" {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": field})
	}
	upstreamTagsRaw, upstreamTagsProvided := rawDocument["upstreamHealthSources"]
	if upstreamTagsProvided && bytes.Equal(bytes.TrimSpace(upstreamTagsRaw), []byte("null")) {
		return opError(http.StatusBadRequest, "invalid_input", "upstreamHealthSources must be an array", nil)
	}
	var upstreamTagValues []string
	if upstreamTagsProvided {
		if json.Unmarshal(upstreamTagsRaw, &upstreamTagValues) != nil || upstreamTagValues == nil {
			return opError(http.StatusBadRequest, "invalid_input", "upstreamHealthSources must be an array of strings", nil)
		}
	}
	upstreamTags, tagIssue := validateUpstreamTags(upstreamTagValues)
	if tagIssue != "" {
		return opError(http.StatusBadRequest, "invalid_input", tagIssue, nil)
	}
	wf, issues := domain.Parse(raw)
	if wf == nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": contractField(issues)})
	}
	// Save accepts the full platform vocabulary — a node type this backend
	// cannot execute yet is a START-time concern, not a save-time one.
	result := workflowvalidation.Validate(wf)
	var blocking []domain.Issue
	for _, issue := range result.Issues {
		if issue.Code != domain.CodeNodeTypeNotExecutable {
			blocking = append(blocking, issue)
		}
	}
	if len(blocking) > 0 {
		rejection := opError(http.StatusBadRequest, "workflows_validation_failed",
			"Validation failed", map[string]any{"issues": blocking})
		rejection.unversionedExtras = map[string]any{"issues": blocking}
		return rejection
	}

	workflowID := wf.ID
	if workflowID == "" || len(workflowID) > 256 {
		workflowID = s.newID()
	}
	name := wf.Name
	if name == "" {
		name = workflowID
	}
	wf.ID = workflowID
	wf.Name = name
	committed, rejection := s.persistWorkflowVersion(
		r.Context(), rc, wf, upstreamTags, upstreamTagsProvided,
	)
	if rejection != nil {
		return *rejection
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "workflow.saved", audit.Options{
		TargetType: "workflow", TargetID: workflowID,
		Metadata: map[string]any{"version": committed.Version, "attempts": committed.Attempts},
	})
	return opOK(map[string]any{
		"workflowId": workflowID, "versionId": committed.VersionID, "version": committed.Version,
	})
}

var workflowSaveTopLevelFields = map[string]bool{
	"dslVersion": true, "id": true, "name": true, "metadata": true,
	"inputs": true, "outputs": true, "templatePolicy": true, "recovery": true,
	"ui": true, "nodes": true, "edges": true, "upstreamHealthSources": true,
}

func unknownWorkflowSaveField(document map[string]json.RawMessage) string {
	var unknown []string
	for field := range document {
		if !workflowSaveTopLevelFields[field] {
			unknown = append(unknown, field)
		}
	}
	sort.Strings(unknown)
	if len(unknown) == 0 {
		return ""
	}
	return unknown[0]
}

const workflowRollbackWriteAttempts = 3

type workflowSaveCommit struct {
	VersionID string
	Version   int32
	Attempts  int
}

// persistWorkflowVersion translates the shared engine operation into the HTTP
// error contract. The engine owns the transaction so API and MCP saves cannot
// drift on locking, reliability inheritance or schedule reconciliation.
func (s *V1Server) persistWorkflowVersion(
	ctx context.Context,
	rc v1Request,
	wf *domain.Workflow,
	upstreamTags json.RawMessage,
	upstreamTagsProvided bool,
) (workflowSaveCommit, *opResult) {
	committed, err := s.engine.SaveWorkflowVersion(ctx, engine.SaveWorkflowVersionInput{
		OrgID: rc.orgID, UserID: rc.userID, Workflow: wf,
		UpstreamHealthSources: upstreamTags, UpstreamHealthSourcesProvided: upstreamTagsProvided,
		NewID: s.newID,
	})
	switch {
	case err == nil:
		return workflowSaveCommit{
			VersionID: committed.VersionID, Version: committed.Version, Attempts: committed.Attempts,
		}, nil
	case errors.Is(err, engine.ErrWorkflowSaveNotFound):
		result := opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
		return workflowSaveCommit{}, &result
	case errors.Is(err, engine.ErrWorkflowSaveIDTaken):
		result := opError(http.StatusConflict, "workflows_save_conflict", "Workflow id is already taken", nil)
		return workflowSaveCommit{}, &result
	case errors.Is(err, engine.ErrWorkflowSaveRolloutActive):
		result := opError(http.StatusConflict, "workflow_rollout_active",
			"Finish the active workflow rollout before saving a new version", nil)
		return workflowSaveCommit{}, &result
	case errors.Is(err, engine.ErrWorkflowSaveConflict):
		result := opError(http.StatusConflict, "workflows_save_conflict",
			"Concurrent save conflict — please retry", map[string]any{"attempts": engine.WorkflowVersionWriteAttempts})
		return workflowSaveCommit{}, &result
	default:
		result := opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		return workflowSaveCommit{}, &result
	}
}

func isRetryableWorkflowVersionWrite(err error) bool {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23505" {
		return false
	}
	return postgresError.ConstraintName == "workflow_versions_org_workflow_version_idx" ||
		postgresError.ConstraintName == "workflows_pkey"
}

func (s *V1Server) listWorkflows(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.listWorkflowsCore(r, rc))
}

func (s *V1Server) listWorkflowsCore(r *http.Request, rc v1Request) opResult {
	query := r.URL.Query()
	limit := 100
	if raw := query.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	beforeCreatedAt := time.Now().Add(time.Hour)
	beforeID := "￿"
	if cursor := query.Get("before"); cursor != "" {
		at, id, ok := parseEventsCursor(cursor)
		if !ok {
			return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
				map[string]any{"field": "before"})
		}
		beforeCreatedAt, beforeID = at, id
	}
	tags := make([]string, 0, 20)
	seenTags := make(map[string]struct{}, 20)
	for _, raw := range query["tag"] {
		tag := strings.TrimSpace(raw)
		if tag == "" || len(tag) > 40 {
			continue
		}
		if _, seen := seenTags[tag]; seen {
			continue
		}
		seenTags[tag] = struct{}{}
		tags = append(tags, tag)
		if len(tags) == 20 {
			break
		}
	}
	tagsJSON, _ := json.Marshal(tags)

	folder := pgtype.Text{}
	if value := strings.TrimSpace(query.Get("folder")); value != "" && len(value) <= 60 {
		folder = pgtype.Text{String: value, Valid: true}
	}
	searchPattern := pgtype.Text{}
	search, bad := parseTextSearchQuery(query.Get("q"), "q")
	if bad != nil {
		return *bad
	}
	if search != "" {
		searchPattern = pgtype.Text{String: "%" + escapeTextSearchLikePattern(search) + "%", Valid: true}
	}
	rows, err := store.New(s.pool).ListWorkflowRows(r.Context(), store.ListWorkflowRowsParams{
		OrgID: rc.orgID, PageLimit: int32(limit),
		BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID,
		Tags: tagsJSON, Folder: folder, SearchPattern: searchPattern,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	items := make([]WorkflowListItemView, 0, len(rows))
	for _, row := range rows {
		items = append(items, newWorkflowListItemView(row))
	}
	return opOK(items)
}

// versionView emits the contract's WorkflowVersion key set; columns the
// runtime does not populate surface as explicit nulls.
func versionView(id, orgID, workflowID string, version int32, dagJSON json.RawMessage, createdBy pgtype.Text, createdAt *time.Time) VersionView {
	return newVersionView(id, orgID, workflowID, version, dagJSON, createdBy, createdAt)
}

// requireActiveWorkflow implements the shared parent gate: missing or
// tombstoned parents read as the same workflow_not_found.
func (s *V1Server) requireActiveWorkflow(r *http.Request, rc v1Request) (string, *opResult) {
	workflowID := strings.TrimSpace(r.URL.Query().Get("workflowId"))
	if workflowID == "" || len(workflowID) > 256 {
		result := opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflowId"})
		return "", &result
	}
	if _, err := store.New(s.pool).GetWorkflow(r.Context(), store.GetWorkflowParams{
		ID: workflowID, OrgID: rc.orgID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			result := opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
			return "", &result
		}
		result := opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		return "", &result
	}
	return workflowID, nil
}

func (s *V1Server) latestWorkflowVersion(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.latestWorkflowVersionCore(r, rc))
}

func (s *V1Server) latestWorkflowVersionCore(r *http.Request, rc v1Request) opResult {
	workflowID, rejection := s.requireActiveWorkflow(r, rc)
	if rejection != nil {
		return *rejection
	}
	row, err := store.New(s.pool).GetLatestWorkflowVersion(r.Context(), store.GetLatestWorkflowVersionParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The contract's response is nullable: an active workflow with no
			// versions reads as null, not an error.
			return opOK(nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(versionView(row.ID, row.OrgID, row.WorkflowID, row.Version,
		row.DagJson, row.CreatedBy, row.CreatedAt))
}

func (s *V1Server) listWorkflowVersions(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.listWorkflowVersionsCore(r, rc))
}

func (s *V1Server) listWorkflowVersionsCore(r *http.Request, rc v1Request) opResult {
	workflowID, rejection := s.requireActiveWorkflow(r, rc)
	if rejection != nil {
		return *rejection
	}
	rows, err := store.New(s.pool).ListWorkflowVersions(r.Context(), store.ListWorkflowVersionsParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	items := make([]VersionView, 0, len(rows))
	for _, row := range rows {
		items = append(items, versionView(row.ID, row.OrgID, row.WorkflowID, row.Version,
			row.DagJson, row.CreatedBy, row.CreatedAt))
	}
	return opOK(items)
}

// workflowVersionSnapshot reads one immutable workflow document by its exact
// version id. Recovery and authoring use this bounded endpoint instead of
// downloading every historical DAG and then guessing which one was attached
// to an incident. The active parent check keeps deleted and cross-tenant
// workflows indistinguishable from missing ones.
func (s *V1Server) workflowVersionSnapshot(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.workflowVersionSnapshotCore(r, rc))
}

func (s *V1Server) workflowVersionSnapshotCore(r *http.Request, rc v1Request) opResult {
	workflowID, rejection := s.requireActiveWorkflow(r, rc)
	if rejection != nil {
		return *rejection
	}
	versionID := strings.TrimSpace(r.PathValue("versionId"))
	if versionID == "" || len(versionID) > 256 {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "versionId"})
	}
	row, err := store.New(s.pool).GetWorkflowVersionByID(r.Context(), store.GetWorkflowVersionByIDParams{
		ID: versionID, OrgID: rc.orgID, WorkflowID: workflowID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "workflow_version_not_found",
				"Workflow version not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(map[string]any{
		"id": row.ID, "workflowId": row.WorkflowID,
		"version": row.Version, "dagJson": normalizedRaw(row.DagJson),
	})
}

// cancelRun ports the contract guards exactly — and note the asymmetry
// with run READS: cancel distinguishes a missing run (404) from a cross-org
// one (403), while reads keep both indistinguishable.

func (s *V1Server) rollbackCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		WorkflowID      string `json:"workflowId"`
		SourceVersionID string `json:"sourceVersionId"`
	}
	if err := decodeBody(r, &body); err != nil || body.WorkflowID == "" || body.SourceVersionID == "" {
		return opError(http.StatusBadRequest, "workflows_rollback_ids_required",
			"workflowId and sourceVersionId are required", nil)
	}
	committed, rejection := s.persistWorkflowRollback(r.Context(), rc, body.WorkflowID, body.SourceVersionID)
	if rejection != nil {
		return *rejection
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "workflow.rolled_back", audit.Options{
		TargetType: "workflow", TargetID: body.WorkflowID,
		Metadata: map[string]any{
			"sourceVersionId": body.SourceVersionID, "sourceVersion": committed.SourceVersion,
			"newVersion": committed.Version, "attempts": committed.Attempts,
		},
	})
	return opOK(map[string]any{
		"workflowId": body.WorkflowID, "versionId": committed.VersionID,
		"version": committed.Version, "sourceVersion": committed.SourceVersion,
	})
}

type workflowRollbackCommit struct {
	VersionID     string
	Version       int32
	SourceVersion int32
	Attempts      int
}

func (s *V1Server) persistWorkflowRollback(
	ctx context.Context, rc v1Request, workflowID, sourceVersionID string,
) (workflowRollbackCommit, *opResult) {
	for attempt := 1; attempt <= workflowRollbackWriteAttempts; attempt++ {
		committed, rejection, err := s.persistWorkflowRollbackAttempt(
			ctx, rc, workflowID, sourceVersionID, attempt,
		)
		if rejection != nil {
			return workflowRollbackCommit{}, rejection
		}
		if err == nil {
			return committed, nil
		}
		if isRetryableWorkflowVersionWrite(err) && attempt < workflowRollbackWriteAttempts {
			continue
		}
		if isRetryableWorkflowVersionWrite(err) {
			result := opError(http.StatusConflict, "workflows_rollback_conflict",
				"Concurrent rollback conflict — please retry", map[string]any{"attempts": workflowRollbackWriteAttempts})
			return workflowRollbackCommit{}, &result
		}
		result := opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		return workflowRollbackCommit{}, &result
	}
	result := opError(http.StatusConflict, "workflows_rollback_conflict",
		"Concurrent rollback conflict — please retry", map[string]any{"attempts": workflowRollbackWriteAttempts})
	return workflowRollbackCommit{}, &result
}

func (s *V1Server) persistWorkflowRollbackAttempt(
	ctx context.Context, rc v1Request, workflowID, sourceVersionID string, attempt int,
) (workflowRollbackCommit, *opResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return workflowRollbackCommit{}, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	if _, err := q.LockWorkflowForRollout(ctx, store.LockWorkflowForRolloutParams{
		OrgID: rc.orgID, ID: workflowID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			result := opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
			return workflowRollbackCommit{}, &result, nil
		}
		return workflowRollbackCommit{}, nil, err
	}
	if _, err := q.FindActiveWorkflowRollout(ctx, store.FindActiveWorkflowRolloutParams{
		OrgID: rc.orgID, WorkflowID: workflowID,
	}); err == nil {
		result := opError(http.StatusConflict, "workflow_rollout_active",
			"Finish the active workflow rollout before creating a rollback version", nil)
		return workflowRollbackCommit{}, &result, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return workflowRollbackCommit{}, nil, err
	}
	source, err := q.GetWorkflowVersionByID(ctx, store.GetWorkflowVersionByIDParams{
		ID: sourceVersionID, OrgID: rc.orgID, WorkflowID: workflowID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			result := opError(http.StatusNotFound, "workflows_source_version_not_found", "Source version not found", nil)
			return workflowRollbackCommit{}, &result, nil
		}
		return workflowRollbackCommit{}, nil, err
	}
	wf, _ := domain.Parse(source.DagJson)
	if wf == nil {
		result := opError(http.StatusUnprocessableEntity, "workflows_version_malformed",
			"Workflow version is malformed", nil)
		return workflowRollbackCommit{}, &result, nil
	}
	canonicalSource, err := domain.CanonicalWorkflowDocument(wf)
	if err != nil {
		return workflowRollbackCommit{}, nil, err
	}
	latest, err := q.GetLatestWorkflowVersionReliability(ctx, store.GetLatestWorkflowVersionReliabilityParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		return workflowRollbackCommit{}, nil, err
	}
	versionID := s.newID()
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: rc.orgID, WorkflowID: workflowID,
		Version: latest.Version + 1, DagJson: canonicalSource,
		CreatedBy:             pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		SloJson:               latest.SloJson,
		UpstreamHealthSources: latest.UpstreamHealthSources,
	}); err != nil {
		return workflowRollbackCommit{}, nil, err
	}
	if err := s.engine.SyncWorkflowSchedules(ctx, q, rc.orgID, workflowID, versionID, rc.userID, wf); err != nil {
		return workflowRollbackCommit{}, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return workflowRollbackCommit{}, nil, err
	}
	return workflowRollbackCommit{
		VersionID: versionID, Version: latest.Version + 1,
		SourceVersion: source.Version, Attempts: attempt,
	}, nil, nil
}

func (s *V1Server) rollbackWorkflow(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.rollbackCore(r, rc))
}

// replayCore is the shared engine redrive with the contract's replay wire
// (success {ok:true}); the runtime-own redrive route reuses it with a richer
// body.

func (s *V1Server) resumeWorkflowCore(r *http.Request, rc v1Request, workflowID string) opResult {
	if workflowID == "" {
		return opError(http.StatusBadRequest, "workflows_workflow_id_required", "workflowId is required", nil)
	}
	outcome, _, err := s.engine.ResumeWorkflowCircuitBreaker(r.Context(), rc.orgID, workflowID, rc.userID)
	if err != nil {
		var notPaused *engine.ErrWorkflowNotBreakerPaused
		switch {
		case errors.Is(err, engine.ErrWorkflowNotFoundForResume):
			return opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
		case errors.As(err, &notPaused):
			return opError(http.StatusConflict, "workflow_not_circuit_breaker_paused",
				"Workflow is not paused by its circuit breaker (status: "+notPaused.Status+")",
				map[string]any{"status": notPaused.Status})
		default:
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
	}
	if outcome.Backfilled > 0 || outcome.Failed > 0 {
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.trigger_backfill", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{
				"backfilled": outcome.Backfilled, "failed": outcome.Failed, "remaining": outcome.Remaining,
			},
		})
	}
	return opOK(map[string]any{
		"ok": true, "workflowId": workflowID, "status": "active",
		"backfilled": outcome.Backfilled, "failed": outcome.Failed, "remaining": outcome.Remaining,
	})
}

// validateUpstreamTags bounds the workflow-level upstream subscription
// list (≤50 names, each 1..80 chars); nil in → nil out (column NULL).
func validateUpstreamTags(tags []string) (json.RawMessage, string) {
	if tags == nil {
		return nil, ""
	}
	if len(tags) > 50 {
		return nil, "upstreamHealthSources allows at most 50 names"
	}
	normalized := make([]string, len(tags))
	for index, tag := range tags {
		trimmed := strings.TrimSpace(tag)
		if trimmed == "" || len(trimmed) > 80 {
			return nil, "upstreamHealthSources entries must be 1..80 characters"
		}
		normalized[index] = trimmed
	}
	serialized, err := json.Marshal(normalized)
	if err != nil {
		return nil, "upstreamHealthSources not serializable"
	}
	return serialized, ""
}
