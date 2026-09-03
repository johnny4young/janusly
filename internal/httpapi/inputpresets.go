// Named run-input presets: an operator saves the input they just filled
// in and re-runs the workflow from the same shape later. Bounded (20 per
// workflow, 64 KiB per preset), org-scoped through the workflow owner
// check, and fail-closed against secret-shaped values — a persisted
// preset must never become an accidental secret store.
package httpapi

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	inputPresetMaxPerWorkflow = 20
	inputPresetMaxBytes       = 64 << 10
	inputPresetNameMaxChars   = 60
)

func inputPresetView(id, name string, inputJSON json.RawMessage, createdBy pgtype.Text, updatedAt any) map[string]any {
	view := map[string]any{
		"id": id, "name": name, "input": inputJSON, "updatedAt": updatedAt,
	}
	if createdBy.Valid {
		view["createdBy"] = createdBy.String
	}
	return view
}

func (s *V1Server) mountInputPresetRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /workflows/{workflowId}/input-presets",
		routeGate{auth.RoleViewer, "workflows.read"},
		func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			workflowID := r.PathValue("workflowId")
			if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
				writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
				return
			}
			rows, err := store.New(s.pool).ListWorkflowInputPresets(r.Context(), store.ListWorkflowInputPresetsParams{
				OrgID: rc.orgID, WorkflowID: workflowID,
			})
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			presets := make([]map[string]any, 0, len(rows))
			for _, row := range rows {
				presets = append(presets, inputPresetView(row.ID, row.Name, row.InputJson, row.CreatedBy, row.UpdatedAt))
			}
			writeUnversioned(w, opOK(map[string]any{"presets": presets}))
		})

	s.route(mux, "PUT /workflows/{workflowId}/input-presets",
		routeGate{auth.RoleEditor, "workflows.write"},
		func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			workflowID := r.PathValue("workflowId")
			if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
				writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
				return
			}
			var body struct {
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			}
			name := ""
			if err := decodeBody(r, &body); err == nil {
				name = strings.TrimSpace(body.Name)
			}
			if name == "" || len(utf16.Encode([]rune(name))) > inputPresetNameMaxChars || len(body.Input) == 0 {
				writeUnversioned(w, opError(http.StatusUnprocessableEntity, "input_preset_invalid",
					"name (1-60 chars) and input are required", nil))
				return
			}
			if len(body.Input) > inputPresetMaxBytes {
				writeUnversioned(w, opError(http.StatusUnprocessableEntity, "input_preset_too_large",
					"preset input exceeds 64 KiB", nil))
				return
			}
			// Same posture as org config: a persisted operator value must
			// never carry secret-shaped material. The pattern is anchored,
			// so it runs per string value, exactly as the catalog does.
			var decoded any
			if err := json.Unmarshal(body.Input, &decoded); err != nil {
				writeUnversioned(w, opError(http.StatusUnprocessableEntity, "input_preset_invalid",
					"input must be valid JSON", nil))
				return
			}
			if presetHoldsSecretShapedValue(decoded) {
				writeUnversioned(w, opError(http.StatusUnprocessableEntity, "input_preset_secret_shaped",
					"preset input looks like credential material; reference secrets from credentials instead", nil))
				return
			}
			tx, err := s.pool.Begin(r.Context())
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			defer func() { _ = tx.Rollback(r.Context()) }()
			q := store.New(tx)
			if err := q.AcquireWorkflowInputPresetLock(r.Context(), store.AcquireWorkflowInputPresetLockParams{
				OrgID: rc.orgID, WorkflowID: workflowID,
			}); err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			count, err := q.CountWorkflowInputPresets(r.Context(), store.CountWorkflowInputPresetsParams{
				OrgID: rc.orgID, WorkflowID: workflowID,
			})
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			if count >= inputPresetMaxPerWorkflow {
				// Replacing an existing name is still allowed at the cap.
				replaces, err := q.WorkflowInputPresetExists(r.Context(), store.WorkflowInputPresetExistsParams{
					OrgID: rc.orgID, WorkflowID: workflowID, Name: name,
				})
				if err != nil {
					writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
					return
				}
				if !replaces {
					writeUnversioned(w, opError(http.StatusUnprocessableEntity, "input_preset_limit",
						"a workflow holds at most 20 presets; delete one first", nil))
					return
				}
			}
			row, err := q.UpsertWorkflowInputPreset(r.Context(), store.UpsertWorkflowInputPresetParams{
				ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
				Name: name, InputJson: body.Input,
				CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
			})
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			if err := tx.Commit(r.Context()); err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			writeUnversioned(w, opOK(map[string]any{
				"preset": inputPresetView(row.ID, row.Name, row.InputJson, row.CreatedBy, row.UpdatedAt),
			}))
		})

	s.route(mux, "DELETE /workflows/{workflowId}/input-presets/{name}",
		routeGate{auth.RoleEditor, "workflows.write"},
		func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			workflowID := r.PathValue("workflowId")
			if !s.ownsActiveWorkflow(r, rc.orgID, workflowID) {
				writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
				return
			}
			deleted, err := store.New(s.pool).DeleteWorkflowInputPreset(r.Context(), store.DeleteWorkflowInputPresetParams{
				OrgID: rc.orgID, WorkflowID: workflowID, Name: r.PathValue("name"),
			})
			if err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			if deleted == 0 {
				writeUnversioned(w, opError(http.StatusNotFound, "input_preset_not_found", "Preset not found", nil))
				return
			}
			writeUnversioned(w, opOK(map[string]any{"ok": true}))
		})
}

// presetHoldsSecretShapedValue walks every string in the preset and runs
// the org-config forbidden-value pattern against each — the pattern is
// start-anchored by design, so serialized-JSON matching would miss
// everything past the first character.
func presetHoldsSecretShapedValue(value any) bool {
	switch typed := value.(type) {
	case string:
		return orgconfig.ForbiddenValuePattern.MatchString(typed)
	case map[string]any:
		for _, nested := range typed {
			if presetHoldsSecretShapedValue(nested) {
				return true
			}
		}
	case []any:
		return slices.ContainsFunc(typed, presetHoldsSecretShapedValue)
	}
	return false
}
