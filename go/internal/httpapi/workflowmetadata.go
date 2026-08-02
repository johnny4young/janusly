// Per-workflow metadata + tags/folders organization (reference
// workflow-metadata-routes.ts + workflowMetadataRepo.ts): owners, runbook
// Markdown, description, tags, Slack/Linear coordinates, default
// severity, and the folder column, plus the org-wide bulk folder/tag
// collection operations and the distinct dropdown feeds (both excluding
// soft-deleted workflows).
//
// Postures kept from the reference: a missing metadata row GETs as
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

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/store"
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
			writeLegacy(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		row, err := store.New(s.pool).GetWorkflowMetadata(r.Context(), store.GetWorkflowMetadataParams{
			OrgID: rc.orgID, WorkflowID: workflowID,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// First load must not trip the UI: 200 with null.
				writeLegacy(w, opOK(map[string]any{"metadata": nil}))
				return
			}
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeLegacy(w, opOK(map[string]any{"metadata": workflowMetadataView(row)}))
	}))

	mux.HandleFunc("POST /workflows/{workflowId}/metadata", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeLegacy(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		var body workflowMetadataBody
		if err := decodeBody(r, &body); err != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "invalid metadata body", nil))
			return
		}
		if message := validateMetadataBody(&body); message != "" {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", message, nil))
			return
		}
		owners, _ := json.Marshal(orEmptySlice(body.Owners))
		tags, _ := json.Marshal(orEmptySlice(body.Tags))
		row, err := store.New(s.pool).UpsertWorkflowMetadata(r.Context(), store.UpsertWorkflowMetadataParams{
			ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
			Owners: owners, Tags: tags,
			Description:     pgtype.Text{String: body.Description, Valid: body.Description != ""},
			SlackChannel:    pgtype.Text{String: body.SlackChannel, Valid: body.SlackChannel != ""},
			LinearProject:   pgtype.Text{String: body.LinearProject, Valid: body.LinearProject != ""},
			SeverityDefault: pgtype.Text{String: body.SeverityDefault, Valid: body.SeverityDefault != ""},
			Folder:          pgtype.Text{String: body.Folder, Valid: body.Folder != ""},
			RunbookMarkdown: pgtype.Text{String: body.RunbookMarkdown, Valid: body.RunbookMarkdown != ""},
			AiGuidanceMarkdown: pgtype.Text{
				String: body.AiGuidanceMarkdown, Valid: body.AiGuidanceMarkdown != "",
			},
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		view := workflowMetadataView(row)
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.metadata.set", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"workflowId": workflowID, "after": metadataForAudit(view)},
		})
		writeLegacy(w, opOK(map[string]any{"metadata": view}))
	}))

	// The NARROW folder route: only the folder column moves.
	mux.HandleFunc("POST /workflows/{workflowId}/folder", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeLegacy(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		var body struct {
			Folder string `json:"folder"`
		}
		if err := decodeBody(r, &body); err != nil || len(body.Folder) > 120 {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "invalid folder body", nil))
			return
		}
		row, err := store.New(s.pool).SetWorkflowFolderOnly(r.Context(), store.SetWorkflowFolderOnlyParams{
			ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
			Folder:    pgtype.Text{String: body.Folder, Valid: body.Folder != ""},
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.metadata.set", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"workflowId": workflowID, "folder": textOrNull(row.Folder)},
		})
		writeLegacy(w, opOK(map[string]any{"metadata": workflowMetadataView(row)}))
	}))

	// The NARROW per-row tag route.
	mux.HandleFunc("POST /workflows/{workflowId}/tags", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
			writeLegacy(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		var body struct {
			Tags []string `json:"tags"`
		}
		if err := decodeBody(r, &body); err != nil || len(body.Tags) > 30 {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "invalid tags body", nil))
			return
		}
		for _, tag := range body.Tags {
			if strings.TrimSpace(tag) == "" || len(tag) > 60 {
				writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "tags must be 1..60 characters", nil))
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
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.tag.set", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"workflowId": workflowID, "tags": body.Tags},
		})
		writeLegacy(w, opOK(map[string]any{"metadata": workflowMetadataView(row)}))
	}))

	// Distinct dropdown feeds — tombstoned workflows excluded.
	mux.HandleFunc("GET /workflows/tags", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		tags, err := store.New(s.pool).ListDistinctWorkflowTags(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeLegacy(w, opOK(map[string]any{"tags": orEmptySlice(tags)}))
	}))
	mux.HandleFunc("GET /workflows/folders", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		folders, err := store.New(s.pool).ListDistinctWorkflowFolders(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeLegacy(w, opOK(map[string]any{"folders": orEmptySlice(folders)}))
	}))

	// Bulk collection ops — org-scoped in the repo, audited with counts.
	mux.HandleFunc("POST /workflows/folders/rename", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct{ From, To string }
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.From) == "" ||
			strings.TrimSpace(body.To) == "" || len(body.To) > 120 {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "from and to are required", nil))
			return
		}
		changed, err := store.New(s.pool).RenameWorkflowFolderBulk(r.Context(), store.RenameWorkflowFolderBulkParams{
			OrgID:      rc.orgID,
			FromFolder: pgtype.Text{String: body.From, Valid: true},
			ToFolder:   pgtype.Text{String: body.To, Valid: true},
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.folder.renamed", audit.Options{
			Metadata: map[string]any{"from": body.From, "to": body.To, "affected": changed},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "affected": changed}))
	}))

	mux.HandleFunc("POST /workflows/folders/delete", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct{ Folder string }
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.Folder) == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "folder is required", nil))
			return
		}
		changed, err := store.New(s.pool).DeleteWorkflowFolderBulk(r.Context(), store.DeleteWorkflowFolderBulkParams{
			OrgID:  rc.orgID,
			Folder: pgtype.Text{String: body.Folder, Valid: true},
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.folder.deleted", audit.Options{
			Metadata: map[string]any{"folder": body.Folder, "affected": changed},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "affected": changed}))
	}))

	mux.HandleFunc("POST /workflows/folders/assign", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			WorkflowIDs []string `json:"workflowIds"`
			Folder      string   `json:"folder"`
		}
		if err := decodeBody(r, &body); err != nil || len(body.WorkflowIDs) == 0 ||
			len(body.WorkflowIDs) > 100 || len(body.Folder) > 120 {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "workflowIds (1..100) required", nil))
			return
		}
		q := store.New(s.pool)
		owned, err := q.ListOwnedActiveWorkflowIDs(r.Context(), store.ListOwnedActiveWorkflowIDsParams{
			OrgID: rc.orgID, Ids: body.WorkflowIDs,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		for _, workflowID := range owned {
			_, _ = q.SetWorkflowFolderOnly(r.Context(), store.SetWorkflowFolderOnlyParams{
				ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
				Folder:    pgtype.Text{String: body.Folder, Valid: body.Folder != ""},
				CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
			})
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.folder.bulk_assigned", audit.Options{
			Metadata: map[string]any{"folder": body.Folder, "workflowIds": owned, "affected": len(owned)},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "affected": len(owned)}))
	}))

	mux.HandleFunc("POST /workflows/tags/assign", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			WorkflowIDs []string `json:"workflowIds"`
			Tag         string   `json:"tag"`
			Remove      bool     `json:"remove"`
		}
		if err := decodeBody(r, &body); err != nil || len(body.WorkflowIDs) == 0 ||
			len(body.WorkflowIDs) > 100 || strings.TrimSpace(body.Tag) == "" || len(body.Tag) > 60 {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "workflowIds and tag required", nil))
			return
		}
		q := store.New(s.pool)
		owned, err := q.ListOwnedActiveWorkflowIDs(r.Context(), store.ListOwnedActiveWorkflowIDsParams{
			OrgID: rc.orgID, Ids: body.WorkflowIDs,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		for _, workflowID := range owned {
			current := []string{}
			if row, err := q.GetWorkflowMetadata(r.Context(), store.GetWorkflowMetadataParams{
				OrgID: rc.orgID, WorkflowID: workflowID,
			}); err == nil {
				_ = json.Unmarshal(row.Tags, &current)
			}
			next := make([]string, 0, len(current)+1)
			present := false
			for _, tag := range current {
				if tag == body.Tag {
					present = true
					if body.Remove {
						continue
					}
				}
				next = append(next, tag)
			}
			if !body.Remove && !present {
				next = append(next, body.Tag)
			}
			tags, _ := json.Marshal(next)
			_, _ = q.SetWorkflowTagsOnly(r.Context(), store.SetWorkflowTagsOnlyParams{
				ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
				Tags:      tags,
				CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
			})
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.tags.bulk_assigned", audit.Options{
			Metadata: map[string]any{"tag": body.Tag, "remove": body.Remove, "workflowIds": owned, "affected": len(owned)},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "affected": len(owned)}))
	}))

	mux.HandleFunc("POST /workflows/tags/rename", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct{ From, To string }
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.From) == "" ||
			strings.TrimSpace(body.To) == "" || len(body.To) > 60 {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "from and to are required", nil))
			return
		}
		changed, err := store.New(s.pool).RenameWorkflowTagBulk(r.Context(), store.RenameWorkflowTagBulkParams{
			OrgID: rc.orgID, FromTag: body.From, ToTag: body.To,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.tag.renamed", audit.Options{
			Metadata: map[string]any{"from": body.From, "to": body.To, "affected": changed},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "affected": changed}))
	}))

	mux.HandleFunc("POST /workflows/tags/delete", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct{ Tag string }
		if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.Tag) == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "workflow_metadata_invalid", "tag is required", nil))
			return
		}
		changed, err := store.New(s.pool).DeleteWorkflowTagBulk(r.Context(), store.DeleteWorkflowTagBulkParams{
			OrgID: rc.orgID, Tag: body.Tag,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.tag.deleted", audit.Options{
			Metadata: map[string]any{"tag": body.Tag, "affected": changed},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "affected": changed}))
	}))
}
