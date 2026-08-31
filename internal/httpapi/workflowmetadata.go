// Per-workflow metadata + tags/folders organization (reference
// workflow-metadata-routes.ts + workflowMetadataRepo.ts): owners, runbook
// Markdown, description, tags, Slack/Linear coordinates, default
// severity, and the folder column, plus the org-wide bulk folder/tag
// collection operations and the distinct dropdown feeds (both excluding
// soft-deleted workflows).
//
// Postures kept from the contract: a missing metadata row GETs as
// `metadata: null` (200, never 404); the narrow `/folder` and `/tags`
// routes touch ONLY their column so the Flows list can't wipe the rest of
// the row; audit rows project aiGuidanceMarkdown to {configured, bytes} —
// free-form AI preferences never persist into audits.
package httpapi

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/store"
)

var severityDefaults = map[string]bool{"p1": true, "p2": true, "p3": true, "p4": true}

func workflowMetadataView(row store.WorkflowMetadatum) map[string]any {
	var owners, tags any
	_ = json.Unmarshal(row.Owners, &owners)
	_ = json.Unmarshal(row.Tags, &tags)
	return map[string]any{
		"workflowId": row.WorkflowID, "owners": owners, "tags": tags,
		"description":  textOrNull(row.Description),
		"slackChannel": textOrNull(row.SlackChannel), "linearProject": textOrNull(row.LinearProject),
		"severityDefault": textOrNull(row.SeverityDefault), "folder": textOrNull(row.Folder),
		"runbookMarkdown":    textOrNull(row.RunbookMarkdown),
		"aiGuidanceMarkdown": textOrNull(row.AiGuidanceMarkdown),
		"createdAt":          isoMillis(row.CreatedAt), "updatedAt": isoMillis(row.UpdatedAt),
	}
}

// metadataForAudit keeps free-form AI preferences out of audit rows while
// preserving change evidence.
func metadataForAudit(view map[string]any) map[string]any {
	projected := map[string]any{}
	maps.Copy(projected, view)
	guidance, _ := view["aiGuidanceMarkdown"].(string)
	projected["aiGuidanceMarkdown"] = map[string]any{
		"configured": guidance != "", "bytes": len(guidance),
	}
	return projected
}

type workflowMetadataBody struct {
	Owners             []string `json:"owners"`
	Tags               []string `json:"tags"`
	Description        string   `json:"description"`
	SlackChannel       string   `json:"slackChannel"`
	LinearProject      string   `json:"linearProject"`
	SeverityDefault    string   `json:"severityDefault"`
	Folder             string   `json:"folder"`
	RunbookMarkdown    string   `json:"runbookMarkdown"`
	AiGuidanceMarkdown string   `json:"aiGuidanceMarkdown"`
}

func validateMetadataBody(body *workflowMetadataBody) string {
	switch {
	case len(body.Owners) > 20:
		return "at most 20 owners"
	case len(body.Tags) > 30:
		return "at most 30 tags"
	case len(body.Description) > 4000 || len(body.RunbookMarkdown) > 65536 || len(body.AiGuidanceMarkdown) > 16384:
		return "metadata field exceeds its cap"
	case len(body.SlackChannel) > 200 || len(body.LinearProject) > 200 || len(body.Folder) > 120:
		return "metadata field exceeds its cap"
	case body.SeverityDefault != "" && !severityDefaults[body.SeverityDefault]:
		return "unknown severityDefault"
	}
	for _, tag := range body.Tags {
		if strings.TrimSpace(tag) == "" || len(tag) > 60 {
			return "tags must be 1..60 characters"
		}
	}
	return ""
}

func (s *V1Server) ownsActiveWorkflow(r *http.Request, orgID, workflowID string) bool {
	owner, err := store.New(s.pool).GetWorkflowIngestState(r.Context(), workflowID)
	return err == nil && owner.OrgID == orgID && owner.DeletedAt == nil
}

func (s *V1Server) mountWorkflowMetadataRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /workflows/{workflowId}/metadata", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		row, err := store.New(s.pool).GetWorkflowMetadata(r.Context(), store.GetWorkflowMetadataParams{
			OrgID: rc.orgID, WorkflowID: workflowID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// First load must not trip the UI: 200 with null.
				writeUnversioned(w, opOK(map[string]any{"metadata": nil}))
				return
			}
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeUnversioned(w, opOK(map[string]any{"metadata": workflowMetadataView(row)}))
	}))

	mux.HandleFunc("POST /workflows/{workflowId}/metadata", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		var body struct {
			Metadata *workflowMetadataBody `json:"metadata"`
		}
		if err := decodeBody(r, &body); err != nil || body.Metadata == nil {
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "workflow_metadata_invalid", "invalid workflow metadata body", nil))
			return
		}
		metadata := body.Metadata
		if message := validateMetadataBody(metadata); message != "" {
			writeUnversioned(w, opError(http.StatusUnprocessableEntity, "workflow_metadata_invalid", message, nil))
			return
		}
		owners, _ := json.Marshal(orEmptySlice(metadata.Owners))
		tags, _ := json.Marshal(orEmptySlice(metadata.Tags))
		row, err := store.New(s.pool).UpsertWorkflowMetadata(r.Context(), store.UpsertWorkflowMetadataParams{
			ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
			Owners: owners, Tags: tags,
			Description:     pgtype.Text{String: metadata.Description, Valid: metadata.Description != ""},
			SlackChannel:    pgtype.Text{String: metadata.SlackChannel, Valid: metadata.SlackChannel != ""},
			LinearProject:   pgtype.Text{String: metadata.LinearProject, Valid: metadata.LinearProject != ""},
			SeverityDefault: pgtype.Text{String: metadata.SeverityDefault, Valid: metadata.SeverityDefault != ""},
			Folder:          pgtype.Text{String: metadata.Folder, Valid: metadata.Folder != ""},
			RunbookMarkdown: pgtype.Text{String: metadata.RunbookMarkdown, Valid: metadata.RunbookMarkdown != ""},
			AiGuidanceMarkdown: pgtype.Text{
				String: metadata.AiGuidanceMarkdown, Valid: metadata.AiGuidanceMarkdown != "",
			},
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		view := workflowMetadataView(row)
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.metadata.set", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"workflowId": workflowID, "after": metadataForAudit(view)},
		})
		writeUnversioned(w, opOK(map[string]any{"metadata": view}))
	}))

	mux.HandleFunc("POST /workflows/{workflowId}/slo", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.setWorkflowSloCore(r, rc, r.PathValue("workflowId")))
	}))

	// The NARROW folder route: only the folder column moves.
	mux.HandleFunc("POST /workflows/{workflowId}/folder", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		var body struct {
			Folder string `json:"folder"`
		}
		if err := decodeBody(r, &body); err != nil || len(body.Folder) > 120 {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "invalid folder body", nil))
			return
		}
		row, err := store.New(s.pool).SetWorkflowFolderOnly(r.Context(), store.SetWorkflowFolderOnlyParams{
			ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
			Folder:    pgtype.Text{String: body.Folder, Valid: body.Folder != ""},
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.metadata.set", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"workflowId": workflowID, "folder": textOrNull(row.Folder)},
		})
		writeUnversioned(w, opOK(map[string]any{"metadata": workflowMetadataView(row)}))
	}))

	// The NARROW per-row tag route.
	mux.HandleFunc("POST /workflows/{workflowId}/tags", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		var body struct {
			Tags []string `json:"tags"`
		}
		if err := decodeBody(r, &body); err != nil || len(body.Tags) > 30 {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "invalid tags body", nil))
			return
		}
		for _, tag := range body.Tags {
			if strings.TrimSpace(tag) == "" || len(tag) > 60 {
				writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "tags must be 1..60 characters", nil))
				return
			}
		}
		tags, _ := json.Marshal(orEmptySlice(body.Tags))
		row, err := store.New(s.pool).SetWorkflowTagsOnly(r.Context(), store.SetWorkflowTagsOnlyParams{
			ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
			Tags:      tags,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.tag.set", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"workflowId": workflowID, "tags": body.Tags},
		})
		writeUnversioned(w, opOK(map[string]any{"metadata": workflowMetadataView(row)}))
	}))

	// Distinct dropdown feeds — tombstoned workflows excluded.
	mux.HandleFunc("GET /workflows/tags", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		tags, err := store.New(s.pool).ListDistinctWorkflowTags(r.Context(), rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeUnversioned(w, opOK(map[string]any{"tags": orEmptySlice(tags)}))
	}))
	mux.HandleFunc("GET /workflows/folders", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		folders, err := store.New(s.pool).ListDistinctWorkflowFolders(r.Context(), rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeUnversioned(w, opOK(map[string]any{"folders": orEmptySlice(folders)}))
	}))

	// Bulk collection ops — org-scoped in the repo, audited with counts.
	mux.HandleFunc("POST /workflows/folders/rename", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct{ From, To string }
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.From) == "" ||
			strings.TrimSpace(body.To) == "" || len(body.To) > 120 {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "from and to are required", nil))
			return
		}
		changed, err := store.New(s.pool).RenameWorkflowFolderBulk(r.Context(), store.RenameWorkflowFolderBulkParams{
			OrgID:      rc.orgID,
			FromFolder: pgtype.Text{String: body.From, Valid: true},
			ToFolder:   pgtype.Text{String: body.To, Valid: true},
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.folder.renamed", audit.Options{
			Metadata: map[string]any{"from": body.From, "to": body.To, "affected": changed},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true, "affected": changed}))
	}))

	mux.HandleFunc("POST /workflows/folders/delete", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct{ Folder string }
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.Folder) == "" {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "folder is required", nil))
			return
		}
		changed, err := store.New(s.pool).DeleteWorkflowFolderBulk(r.Context(), store.DeleteWorkflowFolderBulkParams{
			OrgID:  rc.orgID,
			Folder: pgtype.Text{String: body.Folder, Valid: true},
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.folder.deleted", audit.Options{
			Metadata: map[string]any{"folder": body.Folder, "affected": changed},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true, "affected": changed}))
	}))

	mux.HandleFunc("POST /workflows/folders/assign", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			WorkflowIDs []string `json:"workflowIds"`
			Folder      string   `json:"folder"`
		}
		if err := decodeBody(r, &body); err != nil || len(body.WorkflowIDs) == 0 ||
			len(body.WorkflowIDs) > 100 || len(body.Folder) > 120 {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "workflowIds (1..100) required", nil))
			return
		}
		q := store.New(s.pool)
		owned, err := q.ListOwnedActiveWorkflowIDs(r.Context(), store.ListOwnedActiveWorkflowIDsParams{
			OrgID: rc.orgID, Ids: body.WorkflowIDs,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if len(owned) > 0 {
			if _, err := q.SetWorkflowFolderBulk(r.Context(), store.SetWorkflowFolderBulkParams{
				OrgID:       rc.orgID,
				WorkflowIds: owned,
				Folder:      pgtype.Text{String: body.Folder, Valid: body.Folder != ""},
				CreatedBy:   pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
			}); err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.folder.bulk_assigned", audit.Options{
			Metadata: map[string]any{"folder": body.Folder, "workflowIds": owned, "affected": len(owned)},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true, "affected": len(owned)}))
	}))

	mux.HandleFunc("POST /workflows/tags/assign", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			WorkflowIDs []string `json:"workflowIds"`
			Tag         string   `json:"tag"`
			Remove      bool     `json:"remove"`
		}
		if err := decodeBody(r, &body); err != nil || len(body.WorkflowIDs) == 0 ||
			len(body.WorkflowIDs) > 100 || strings.TrimSpace(body.Tag) == "" || len(body.Tag) > 60 {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "workflowIds and tag required", nil))
			return
		}
		q := store.New(s.pool)
		owned, err := q.ListOwnedActiveWorkflowIDs(r.Context(), store.ListOwnedActiveWorkflowIDsParams{
			OrgID: rc.orgID, Ids: body.WorkflowIDs,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		// The add/remove is expressed on the jsonb array itself, so one
		// statement covers the whole selection instead of a read plus a
		// write per workflow.
		if len(owned) > 0 {
			var err error
			if body.Remove {
				_, err = q.RemoveWorkflowTagBulk(r.Context(), store.RemoveWorkflowTagBulkParams{
					OrgID: rc.orgID, WorkflowIds: owned, Tag: body.Tag,
				})
			} else {
				_, err = q.AddWorkflowTagBulk(r.Context(), store.AddWorkflowTagBulkParams{
					OrgID: rc.orgID, WorkflowIds: owned, Tag: body.Tag,
					CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
				})
			}
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.tags.bulk_assigned", audit.Options{
			Metadata: map[string]any{"tag": body.Tag, "remove": body.Remove, "workflowIds": owned, "affected": len(owned)},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true, "affected": len(owned)}))
	}))

	mux.HandleFunc("POST /workflows/tags/rename", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct{ From, To string }
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.From) == "" ||
			strings.TrimSpace(body.To) == "" || len(body.To) > 60 {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "from and to are required", nil))
			return
		}
		changed, err := store.New(s.pool).RenameWorkflowTagBulk(r.Context(), store.RenameWorkflowTagBulkParams{
			OrgID: rc.orgID, FromTag: body.From, ToTag: body.To,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.tag.renamed", audit.Options{
			Metadata: map[string]any{"from": body.From, "to": body.To, "affected": changed},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true, "affected": changed}))
	}))

	mux.HandleFunc("POST /workflows/tags/delete", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct{ Tag string }
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.Tag) == "" {
			writeUnversioned(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "tag is required", nil))
			return
		}
		changed, err := store.New(s.pool).DeleteWorkflowTagBulk(r.Context(), store.DeleteWorkflowTagBulkParams{
			OrgID: rc.orgID, Tag: body.Tag,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.tag.deleted", audit.Options{
			Metadata: map[string]any{"tag": body.Tag, "affected": changed},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true, "affected": changed}))
	}))
}

// workflowSloBody mirrors the closed Reliability declaration. Pointer fields
// preserve the distinction between an unset threshold and zero.
type workflowSloBody struct {
	SuccessRatePercent    *float64 `json:"successRatePercent"`
	MttrSeconds           *int     `json:"mttrSeconds"`
	P95DurationMs         *int     `json:"p95DurationMs"`
	BudgetBlocksPerWindow *int     `json:"budgetBlocksPerWindow"`
	StuckWaitingNodesMax  *int     `json:"stuckWaitingNodesMax"`
	WindowDays            int      `json:"windowDays"`
}

func validWorkflowSlo(slo workflowSloBody) bool {
	if slo.WindowDays != 7 && slo.WindowDays != 14 && slo.WindowDays != 30 {
		return false
	}
	if slo.SuccessRatePercent != nil && (*slo.SuccessRatePercent < 0 || *slo.SuccessRatePercent > 100) {
		return false
	}
	for _, value := range []*int{slo.MttrSeconds, slo.P95DurationMs, slo.BudgetBlocksPerWindow, slo.StuckWaitingNodesMax} {
		if value != nil && *value < 0 {
			return false
		}
	}
	return true
}

func (s *V1Server) setWorkflowSloCore(r *http.Request, rc v1Request, workflowID string) opResult {
	if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
		return opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
	}
	var body struct {
		Slo *workflowSloBody `json:"slo"`
	}
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusUnprocessableEntity, "workflow_slo_invalid", "Invalid SLO body", nil)
	}
	var sloJSON json.RawMessage = []byte("null")
	if body.Slo != nil {
		if !validWorkflowSlo(*body.Slo) {
			return opError(http.StatusUnprocessableEntity, "workflow_slo_invalid",
				"windowDays must be 7, 14 or 30 and every threshold non-negative", nil)
		}
		encoded, err := json.Marshal(body.Slo)
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
		sloJSON = encoded
	}
	versionID, err := store.New(s.pool).SetLatestWorkflowSlo(r.Context(), store.SetLatestWorkflowSloParams{
		OrgID: rc.orgID, WorkflowID: workflowID, SloJson: sloJSON,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "workflow_not_found", "Workflow has no saved version", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "workflow.slo.set", audit.Options{
		TargetType: "workflow", TargetID: workflowID,
		Metadata: map[string]any{"workflowId": workflowID, "versionId": versionID, "cleared": body.Slo == nil},
	})
	var declared any
	if body.Slo != nil {
		declared = body.Slo
	}
	return opOK(map[string]any{"workflowId": workflowID, "slo": declared, "versionId": versionID})
}
