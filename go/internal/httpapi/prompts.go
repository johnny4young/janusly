// PromptOps registry surface — the reference's prompts routes in the
// subset the hot-swap loop needs: create a named prompt, append immutable
// versions, pin the active one, list. Wire shapes and error codes match
// the reference; version numbering retries the unique-violation window
// like every other version writer.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/prompts"
	"github.com/johnny4young/janusly/go/internal/store"
)

const (
	promptNameMax        = 128
	promptDescriptionMax = 2000
	promptTemplateMax    = 32_000
)

func promptView(row store.Prompt) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "name": row.Name,
		"description":     textOrNull(row.Description),
		"pinnedVersionId": textOrNull(row.PinnedVersionID),
		"createdBy":       textOrNull(row.CreatedBy),
		"createdAt":       timeOrNull(row.CreatedAt), "updatedAt": timeOrNull(row.UpdatedAt),
	}
}

func promptVersionView(row store.PromptVersion) map[string]any {
	var variables any = json.RawMessage(row.Variables)
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "promptId": row.PromptID,
		"version": row.Version, "templateText": row.TemplateText,
		"variables": variables, "status": row.Status,
		"createdBy": textOrNull(row.CreatedBy), "createdAt": timeOrNull(row.CreatedAt),
	}
}

func (s *V1Server) createPromptCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := decodeBody(r, &body); err != nil || body.Name == "" || len(body.Name) > promptNameMax {
		return opError(http.StatusBadRequest, "prompts_name_invalid",
			"name is required and must be 1..128 chars", nil)
	}
	if len(body.Description) > promptDescriptionMax {
		return opError(http.StatusBadRequest, "prompts_description_too_long",
			"description too long", map[string]any{"max": promptDescriptionMax})
	}
	ctx := r.Context()
	q := store.New(s.pool)
	if _, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: rc.orgID, Name: body.Name}); err == nil {
		return opError(http.StatusConflict, "prompts_name_duplicate",
			"a prompt with this name already exists", nil)
	}
	id := s.newID()
	if err := q.InsertPrompt(ctx, store.InsertPromptParams{
		ID: id, OrgID: rc.orgID, Name: body.Name,
		Description: pgtype.Text{String: body.Description, Valid: body.Description != ""},
		CreatedBy:   pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	audit.Write(ctx, s.pool, rc.authContext, "prompt.created", audit.Options{
		TargetType: "prompt", TargetID: id, Metadata: map[string]any{"name": body.Name},
	})
	created, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: rc.orgID, Name: body.Name})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opResult{status: http.StatusCreated, data: map[string]any{"prompt": promptView(created)}}
}

func (s *V1Server) createPromptVersionCore(r *http.Request, rc v1Request, name string) opResult {
	var body struct {
		TemplateText string          `json:"templateText"`
		Variables    json.RawMessage `json:"variables"`
	}
	if err := decodeBody(r, &body); err != nil || body.TemplateText == "" {
		return opError(http.StatusBadRequest, "prompts_template_required", "templateText is required", nil)
	}
	if len(body.TemplateText) > promptTemplateMax {
		return opError(http.StatusBadRequest, "prompts_template_too_long",
			"templateText too long", map[string]any{"max": promptTemplateMax})
	}
	variables := body.Variables
	if len(variables) == 0 {
		variables = json.RawMessage(`[]`)
	}
	var declared []prompts.Variable
	if err := json.Unmarshal(variables, &declared); err != nil {
		return opError(http.StatusBadRequest, "prompts_variables_invalid",
			"variables: must be an array of {name, required?, default?}", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	prompt, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "prompts_not_found", "prompt not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	// Bounded unique-violation retry, the shared version-writer policy.
	var created store.PromptVersion
	for range 3 {
		next, err := q.NextPromptVersionNumber(ctx, store.NextPromptVersionNumberParams{
			OrgID: rc.orgID, PromptID: prompt.ID,
		})
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		}
		id := s.newID()
		if err := q.InsertPromptVersion(ctx, store.InsertPromptVersionParams{
			ID: id, OrgID: rc.orgID, PromptID: prompt.ID, Version: int32(next),
			TemplateText: body.TemplateText, Variables: variables,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		}); err != nil {
			continue // a concurrent writer took the number; recompute
		}
		created, err = q.GetPromptVersionByID(ctx, store.GetPromptVersionByIDParams{OrgID: rc.orgID, ID: id})
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		}
		audit.Write(ctx, s.pool, rc.authContext, "prompt.version_created", audit.Options{
			TargetType: "prompt_version", TargetID: id,
			Metadata: map[string]any{"name": prompt.Name, "version": next, "promptId": prompt.ID},
		})
		return opResult{status: http.StatusCreated, data: map[string]any{"version": promptVersionView(created)}}
	}
	return opError(http.StatusConflict, "prompts_version_conflict",
		"concurrent version writes — please retry", nil)
}

func (s *V1Server) pinPromptVersionCore(r *http.Request, rc v1Request, name string, version int) opResult {
	ctx := r.Context()
	q := store.New(s.pool)
	prompt, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "prompts_not_found", "prompt not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	target, err := q.GetPromptVersionByNumber(ctx, store.GetPromptVersionByNumberParams{
		OrgID: rc.orgID, PromptID: prompt.ID, Version: int32(version),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "prompts_version_not_found", "prompt version not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if _, err := q.PinPromptVersion(ctx, store.PinPromptVersionParams{
		OrgID: rc.orgID, ID: prompt.ID,
		PinnedVersionID: pgtype.Text{String: target.ID, Valid: true},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	audit.Write(ctx, s.pool, rc.authContext, "prompt.version_pinned", audit.Options{
		TargetType: "prompt", TargetID: prompt.ID,
		Metadata: map[string]any{"name": prompt.Name, "version": version, "versionId": target.ID},
	})
	return opOK(map[string]any{"ok": true, "pinnedVersionId": target.ID})
}

func (s *V1Server) mountPromptRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /prompts", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).ListPrompts(r.Context(), store.ListPromptsParams{OrgID: rc.orgID, Limit: 100})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, promptView(row))
		}
		writeLegacy(w, opOK(map[string]any{"prompts": views}))
	}))
	mux.HandleFunc("POST /prompts", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.createPromptCore(r, rc))
	}))
	mux.HandleFunc("POST /prompts/{name}/versions", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.createPromptVersionCore(r, rc, r.PathValue("name")))
	}))
	mux.HandleFunc("POST /prompts/{name}/versions/{version}/pin", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		version, err := parsePositiveInt(r.PathValue("version"), 1_000_000)
		if err != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "prompts_invalid_url", "invalid url", nil))
			return
		}
		writeLegacy(w, s.pinPromptVersionCore(r, rc, r.PathValue("name"), version))
	}))
}
