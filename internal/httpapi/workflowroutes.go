// Workflow lifecycle handlers: save (with upstream tags + SLO carriers),
// list/latest/versions reads, rollback, and circuit-breaker resume. The
// contract and dual-run suites guard the preserved wire behavior.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

func (s *V1Server) saveWorkflow(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.saveCore(r, rc))
}

func (s *V1Server) saveCore(r *http.Request, rc v1Request) opResult {

	var raw json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	// Optional workflow-level upstream subscription tags ride the save body
	// (they live on workflow_versions, not in the DAG JSON).
	var tagCarrier struct {
		UpstreamHealthSources []string `json:"upstreamHealthSources"`
	}
	_ = json.Unmarshal(raw, &tagCarrier)
	upstreamTags, tagIssue := validateUpstreamTags(tagCarrier.UpstreamHealthSources)
	if tagIssue != "" {
		return opError(http.StatusBadRequest, "invalid_input", tagIssue, nil)
	}
	sloJSON, sloIssue := parseWorkflowSloBody(raw)
	if sloIssue != "" {
		return opError(http.StatusBadRequest, "invalid_input", sloIssue, nil)
	}
	wf, issues := domain.Parse(raw)
	if wf == nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": contractField(issues)})
	}
	// Save accepts the full platform vocabulary — a node type this backend
	// cannot execute yet is a START-time concern, not a save-time one.
	result := domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation)
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

	ctx := r.Context()
	q := store.New(s.pool)
	workflowID := wf.ID
	if workflowID == "" {
		workflowID = s.newID()
	}
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: rc.orgID}); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
		name := wf.Name
		if name == "" {
			name = workflowID
		}
		if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{
			ID: workflowID, OrgID: rc.orgID, Name: name,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		}); err != nil {
			if strings.Contains(err.Error(), "workflows_pkey") {
				// The id exists but the active-parent read missed it: either a
				// tombstone in THIS org (a save never resurrects one — the
				// operator restores explicitly first) or another tenant's id.
				owner, stateErr := q.GetWorkflowOwnerState(ctx, workflowID)
				if stateErr == nil && owner.OrgID == rc.orgID && owner.DeletedAt != nil {
					return opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
				}
				return opError(http.StatusConflict, "workflows_save_conflict",
					"Workflow id is already taken", nil)
			}
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
	}
	// Version-write locking: a live rollout owns which versions serve
	// traffic — minting a hidden newer version would silently detach the
	// canary from "latest". Finish the rollout first.
	if _, err := q.FindActiveWorkflowRollout(ctx, store.FindActiveWorkflowRolloutParams{
		OrgID: rc.orgID, WorkflowID: workflowID,
	}); err == nil {
		return opError(http.StatusConflict, "workflow_rollout_active",
			"Finish the active workflow rollout before saving a new version", nil)
	}
	version, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	versionID := s.newID()
	// The contract's WorkflowSchema.parse defaults `metadata: {tags: []}`
	// into the persisted dagJson; mirror it so /workflows/latest and the
	// version history serve byte-identical snapshots (dual-run pin).
	dagJSONWithDefaults := raw
	var dagDoc map[string]any
	if err := json.Unmarshal(raw, &dagDoc); err == nil {
		if _, present := dagDoc["metadata"]; !present {
			dagDoc["metadata"] = map[string]any{"tags": []any{}}
			if encoded, err := json.Marshal(dagDoc); err == nil {
				dagJSONWithDefaults = encoded
			}
		}
	}
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: rc.orgID, WorkflowID: workflowID,
		Version: version + 1, DagJson: dagJSONWithDefaults,
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},

		UpstreamHealthSources: upstreamTags,
		SloJson:               sloJSON,
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	// The entry set can never drift from the saved DAG: schedules re-sync
	// from THIS snapshot on every save.
	if err := s.engine.SyncWorkflowSchedules(ctx, q, rc.orgID, workflowID, versionID, rc.userID, wf); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	audit.Write(ctx, s.pool, rc.authContext, "workflow.saved", audit.Options{
		TargetType: "workflow", TargetID: workflowID,
		Metadata: map[string]any{"version": version + 1},
	})
	return opOK(map[string]any{
		"workflowId": workflowID, "versionId": versionID, "version": version + 1,
	})
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
	if value := strings.TrimSpace(query.Get("q")); value != "" && len(value) <= 100 {
		searchPattern = pgtype.Text{String: "%" + escapeWorkflowLikePattern(value) + "%", Valid: true}
	}
	rows, err := store.New(s.pool).ListWorkflowRows(r.Context(), store.ListWorkflowRowsParams{
		OrgID: rc.orgID, PageLimit: int32(limit),
		BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID,
		Tags: tagsJSON, Folder: folder, SearchPattern: searchPattern,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	items := make([]WorkflowListItemView, 0, len(rows))
	for _, row := range rows {
		items = append(items, newWorkflowListItemView(row))
	}
	return opOK(items)
}

func escapeWorkflowLikePattern(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
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
	if workflowID == "" {
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
		result := opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	items := make([]VersionView, 0, len(rows))
	for _, row := range rows {
		items = append(items, versionView(row.ID, row.OrgID, row.WorkflowID, row.Version,
			row.DagJson, row.CreatedBy, row.CreatedAt))
	}
	return opOK(items)
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
	ctx := r.Context()
	q := store.New(s.pool)
	owner, err := q.GetWorkflowOwnerState(ctx, body.WorkflowID)
	if err != nil || owner.OrgID != rc.orgID || owner.DeletedAt != nil {
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
		return opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
	}
	if _, err := q.FindActiveWorkflowRollout(ctx, store.FindActiveWorkflowRolloutParams{
		OrgID: rc.orgID, WorkflowID: body.WorkflowID,
	}); err == nil {
		return opError(http.StatusConflict, "workflow_rollout_active",
			"Finish the active workflow rollout before creating a rollback version", nil)
	}
	source, err := q.GetWorkflowVersionByID(ctx, store.GetWorkflowVersionByIDParams{
		ID: body.SourceVersionID, OrgID: rc.orgID, WorkflowID: body.WorkflowID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "workflows_source_version_not_found", "Source version not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	if wf, _ := domain.Parse(source.DagJson); wf == nil {
		return opError(http.StatusUnprocessableEntity, "workflows_version_malformed",
			"Workflow version is malformed", nil)
	}
	version, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		WorkflowID: body.WorkflowID, OrgID: rc.orgID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	versionID := s.newID()
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: rc.orgID, WorkflowID: body.WorkflowID,
		Version: version + 1, DagJson: source.DagJson,
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return opError(http.StatusConflict, "workflows_rollback_conflict",
				"Concurrent rollback conflict — please retry", map[string]any{"attempts": 1})
		}
		if rolledWf, _ := domain.Parse(source.DagJson); rolledWf != nil {
			if err := s.engine.SyncWorkflowSchedules(ctx, q, rc.orgID, body.WorkflowID, versionID, rc.userID, rolledWf); err != nil {
				return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
			}
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	audit.Write(ctx, s.pool, rc.authContext, "workflow.rolled_back", audit.Options{
		TargetType: "workflow", TargetID: body.WorkflowID,
		Metadata: map[string]any{
			"sourceVersionId": body.SourceVersionID, "sourceVersion": source.Version,
			"newVersion": version + 1,
		},
	})
	return opOK(map[string]any{
		"workflowId": body.WorkflowID, "versionId": versionID,
		"version": version + 1, "sourceVersion": source.Version,
	})
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
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
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
	for _, tag := range tags {
		trimmed := strings.TrimSpace(tag)
		if trimmed == "" || len(tag) > 80 {
			return nil, "upstreamHealthSources entries must be 1..80 characters"
		}
	}
	serialized, err := json.Marshal(tags)
	if err != nil {
		return nil, "upstreamHealthSources not serializable"
	}
	return serialized, ""
}
