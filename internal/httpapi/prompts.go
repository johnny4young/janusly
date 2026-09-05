// PromptOps registry surface — the contract's prompts routes in the
// subset the hot-swap loop needs: create a named prompt, append immutable
// versions, pin the active one, list. Wire shapes and error codes match
// the contract; version numbering retries the unique-violation window
// like every other version writer.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/prompts"
	"github.com/johnny4young/janusly/internal/store"
)

const (
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
	if err := decodeBody(r, &body); err != nil || domain.ValidatePromptName(body.Name) != nil {
		return opError(http.StatusBadRequest, "prompts_name_invalid",
			"name must be a URL-safe 1..128 character identifier", nil)
	}
	if utf8.RuneCountInString(body.Description) > promptDescriptionMax {
		return opError(http.StatusBadRequest, "prompts_description_too_long",
			"description too long", map[string]any{"max": promptDescriptionMax})
	}
	ctx := r.Context()
	q := store.New(s.pool)
	if _, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: rc.orgID, Name: body.Name}); err == nil {
		return opError(http.StatusConflict, "prompts_name_duplicate",
			"a prompt with this name already exists", nil)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	id := s.newID()
	if err := q.InsertPrompt(ctx, store.InsertPromptParams{
		ID: id, OrgID: rc.orgID, Name: body.Name,
		Description: pgtype.Text{String: body.Description, Valid: body.Description != ""},
		CreatedBy:   pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		if isUniqueViolation(err) {
			return opError(http.StatusConflict, "prompts_name_duplicate",
				"a prompt with this name already exists", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(ctx, s.pool, rc.authContext, "prompt.created", audit.Options{
		TargetType: "prompt", TargetID: id, Metadata: map[string]any{"name": body.Name},
	})
	created, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: rc.orgID, Name: body.Name})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opResult{status: http.StatusCreated, data: map[string]any{"prompt": promptView(created)}}
}

func (s *V1Server) createPromptVersionCore(r *http.Request, rc v1Request, name string) opResult {
	if domain.ValidatePromptName(name) != nil {
		return opError(http.StatusBadRequest, "prompts_name_invalid",
			"name must be a URL-safe 1..128 character identifier", nil)
	}
	var body struct {
		TemplateText string          `json:"templateText"`
		Variables    json.RawMessage `json:"variables"`
	}
	if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.TemplateText) == "" {
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
	declared, err := prompts.DecodeVariables(variables)
	if err != nil {
		return opError(http.StatusBadRequest, "prompts_variables_invalid",
			err.Error(), nil)
	}
	variables, err = json.Marshal(declared)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	prompt, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "prompts_not_found", "prompt not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	// Bounded unique-violation retry, the shared version-writer policy.
	var created store.PromptVersion
	for range 3 {
		next, err := q.NextPromptVersionNumber(ctx, store.NextPromptVersionNumberParams{
			OrgID: rc.orgID, PromptID: prompt.ID,
		})
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
		id := s.newID()
		if err := q.InsertPromptVersion(ctx, store.InsertPromptVersionParams{
			ID: id, OrgID: rc.orgID, PromptID: prompt.ID, Version: int32(next),
			TemplateText: body.TemplateText, Variables: variables,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		}); err != nil {
			if isUniqueViolation(err) {
				continue // a concurrent writer took the number; recompute
			}
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
		created, err = q.GetPromptVersionByID(ctx, store.GetPromptVersionByIDParams{OrgID: rc.orgID, ID: id})
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
	if domain.ValidatePromptName(name) != nil {
		return opError(http.StatusBadRequest, "prompts_name_invalid",
			"name must be a URL-safe 1..128 character identifier", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	prompt, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "prompts_not_found", "prompt not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	target, err := q.GetPromptVersionByNumber(ctx, store.GetPromptVersionByNumberParams{
		OrgID: rc.orgID, PromptID: prompt.ID, Version: int32(version),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "prompts_version_not_found", "prompt version not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if _, err := q.PinPromptVersion(ctx, store.PinPromptVersionParams{
		OrgID: rc.orgID, ID: prompt.ID,
		PinnedVersionID: pgtype.Text{String: target.ID, Valid: true},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(ctx, s.pool, rc.authContext, "prompt.version_pinned", audit.Options{
		TargetType: "prompt", TargetID: prompt.ID,
		Metadata: map[string]any{"name": prompt.Name, "version": version, "versionId": target.ID},
	})
	return opOK(map[string]any{"ok": true, "pinnedVersionId": target.ID})
}

func (s *V1Server) mountPromptRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /prompts", routeGate{auth.RoleViewer, "prompts.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).ListPrompts(r.Context(), store.ListPromptsParams{OrgID: rc.orgID, Limit: 100})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, promptView(row))
		}
		writeUnversioned(w, opOK(map[string]any{"prompts": views}))
	})
	s.route(mux, "POST /prompts", routeGate{auth.RoleViewer, "prompts.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.createPromptCore(r, rc))
	})
	s.route(mux, "POST /prompts/{name}/versions", routeGate{auth.RoleViewer, "prompts.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.createPromptVersionCore(r, rc, r.PathValue("name")))
	})
	s.route(mux, "POST /prompts/{name}/versions/{version}/pin", routeGate{auth.RoleViewer, "prompts.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		version, err := parsePositiveInt(r.PathValue("version"), 1_000_000)
		if err != nil {
			writeUnversioned(w, opError(http.StatusBadRequest, "prompts_invalid_url", "invalid url", nil))
			return
		}
		writeUnversioned(w, s.pinPromptVersionCore(r, rc, r.PathValue("name"), version))
	})
}
