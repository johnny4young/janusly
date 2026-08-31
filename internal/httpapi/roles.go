// Org roles CRUD + permission overrides, implements the contract's
// roles routes: custom-role creation (name grammar, built-in names
// rejected toward the override path), the update route that serves BOTH
// built-in overrides (row upserted on first override; inheritsFrom
// immutable) and custom edits, the admin self-lockout floor with its
// coerced keys audited under metadata.coerced, and the delete ladder —
// built-in name reverts the override, a custom with members answers 409
// role_in_use with membersAffected at the envelope's top level.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

var roleNamePattern = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// parsePermissions validates a grantedPermissions array against the
// catalog; the first bad key names the 400.
func parsePermissions(raw any) ([]string, string, bool) {
	if raw == nil {
		return nil, "", true
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, "grantedPermissions must be an array", false
	}
	keys := make([]string, 0, len(list))
	for _, item := range list {
		key, ok := item.(string)
		if !ok || !auth.IsPermission(key) {
			return nil, "unknown permission key", false
		}
		keys = append(keys, key)
	}
	return keys, "", true
}

func roleViewFrom(id, orgID, name, inheritsFrom string, description pgtype.Text, isBuiltin bool, grantedPermissions []byte) map[string]any {
	var grants any
	if len(grantedPermissions) > 0 && string(grantedPermissions) != "null" {
		var keys []string
		_ = json.Unmarshal(grantedPermissions, &keys)
		grants = keys
	} else if isBuiltin && auth.IsBuiltinRole(name) {
		grants = auth.DefaultPermissionsForRole(auth.Role(name))
	}
	return map[string]any{
		"id": id, "orgId": orgID, "name": name,
		"inheritsFrom": inheritsFrom, "description": textOrNull(description),
		"isBuiltin": isBuiltin, "grantedPermissions": grants,
	}
}

func (s *V1Server) permissionsCatalogCore(_ *http.Request, _ v1Request) opResult {
	catalog := make([]map[string]any, 0, len(auth.PermissionCatalog))
	for _, entry := range auth.PermissionCatalog {
		roles := []string{}
		for _, role := range []auth.Role{auth.RoleViewer, auth.RoleEditor, auth.RoleAdmin} {
			if entry.DefaultRoles[role] {
				roles = append(roles, string(role))
			}
		}
		catalog = append(catalog, map[string]any{
			"key": entry.Key, "category": entry.Category,
			"description": entry.Description, "defaultRoles": roles,
		})
	}
	return opOK(map[string]any{
		"catalog":                   catalog,
		"mandatoryAdminPermissions": auth.MandatoryAdminPermissions(),
	})
}

func (s *V1Server) listRolesCore(r *http.Request, rc v1Request) opResult {
	rows, err := store.New(s.pool).ListOrgRoles(r.Context(), rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	byName := map[string]bool{}
	roles := make([]map[string]any, 0, len(rows)+3)
	for _, row := range rows {
		byName[row.Name] = true
		roles = append(roles, roleViewFrom(row.ID, row.OrgID, row.Name, row.InheritsFrom, row.Description, row.IsBuiltin, row.GrantedPermissions))
	}
	// Built-ins are VIRTUAL until overridden.
	for _, builtin := range []auth.Role{auth.RoleViewer, auth.RoleEditor, auth.RoleAdmin} {
		if !byName[string(builtin)] {
			roles = append(roles, map[string]any{
				"name": string(builtin), "inheritsFrom": string(builtin),
				"isBuiltin": true, "description": nil,
				"grantedPermissions": auth.DefaultPermissionsForRole(builtin),
			})
		}
	}
	return opOK(map[string]any{"roles": roles})
}

func (s *V1Server) createRoleCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Name               string `json:"name"`
		InheritsFrom       string `json:"inheritsFrom"`
		Description        string `json:"description"`
		GrantedPermissions any    `json:"grantedPermissions"`
	}
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "roles_name_invalid", "name must match /^[a-z0-9_-]{1,32}$/", nil)
	}
	name := strings.ToLower(strings.TrimSpace(body.Name))
	if !roleNamePattern.MatchString(name) {
		return opError(http.StatusBadRequest, "roles_name_invalid", "name must match /^[a-z0-9_-]{1,32}$/", nil)
	}
	if auth.IsBuiltinRole(name) {
		return opError(http.StatusBadRequest, "roles_builtin_name",
			"cannot create a custom role with a built-in name; use POST /org/roles/:name to override a built-in", nil)
	}
	inheritsFrom := "viewer"
	if auth.IsBuiltinRole(body.InheritsFrom) {
		inheritsFrom = body.InheritsFrom
	}
	permissions, bad, ok := parsePermissions(body.GrantedPermissions)
	if !ok {
		return opError(http.StatusBadRequest, "roles_permissions_invalid", bad, nil)
	}
	ctx := r.Context()
	if _, err := store.New(s.pool).GetOrgRole(ctx, store.GetOrgRoleParams{OrgID: rc.orgID, Name: name}); err == nil {
		return opError(http.StatusConflict, "role_already_exists", "role with this name already exists",
			map[string]any{"name": name})
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	roleID := s.newID()
	var grantsJSON []byte
	if permissions != nil {
		grantsJSON, _ = json.Marshal(permissions)
	}
	description := body.Description
	if len(description) > 240 {
		description = description[:240]
	}
	err := audit.WithAuditTx(ctx, s.pool, rc.authContext, func(tx pgx.Tx, txAudit audit.TxAudit) error {
		if err := store.New(tx).InsertOrgRole(ctx, store.InsertOrgRoleParams{
			ID: roleID, OrgID: rc.orgID, Name: name, InheritsFrom: inheritsFrom,
			Description: pgtype.Text{String: description, Valid: description != ""},
			IsBuiltin:   false, GrantedPermissions: grantsJSON,
		}); err != nil {
			return err
		}
		return txAudit("org.role.created", audit.Options{
			TargetType: "org_role", TargetID: roleID,
			Metadata: map[string]any{"name": name, "inheritsFrom": inheritsFrom, "grantedPermissions": permissions},
		})
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	row, err := store.New(s.pool).GetOrgRole(ctx, store.GetOrgRoleParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(roleViewFrom(row.ID, row.OrgID, row.Name, row.InheritsFrom, row.Description, row.IsBuiltin, row.GrantedPermissions))
}

func (s *V1Server) updateRoleCore(r *http.Request, rc v1Request, rawName string) opResult {
	name := strings.ToLower(strings.TrimSpace(rawName))
	if name == "" {
		return opError(http.StatusBadRequest, "roles_name_required", "role name is required", nil)
	}
	var body struct {
		InheritsFrom       *string `json:"inheritsFrom"`
		Description        *string `json:"description"`
		GrantedPermissions any     `json:"grantedPermissions"`
		HasGrants          bool    `json:"-"`
	}
	rawBody := map[string]json.RawMessage{}
	if err := decodeBody(r, &rawBody); err != nil {
		return opError(http.StatusBadRequest, "roles_no_updatable_fields", "no updatable fields provided", nil)
	}
	if raw, present := rawBody["inheritsFrom"]; present {
		var value string
		_ = json.Unmarshal(raw, &value)
		body.InheritsFrom = &value
	}
	if raw, present := rawBody["description"]; present {
		var value string
		_ = json.Unmarshal(raw, &value)
		body.Description = &value
	}
	if raw, present := rawBody["grantedPermissions"]; present {
		var value any
		_ = json.Unmarshal(raw, &value)
		body.GrantedPermissions = value
		body.HasGrants = true
	}

	isBuiltinTarget := auth.IsBuiltinRole(name)
	ctx := r.Context()
	existing, err := store.New(s.pool).GetOrgRole(ctx, store.GetOrgRoleParams{OrgID: rc.orgID, Name: name})
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if !isBuiltinTarget && !exists {
		return opError(http.StatusNotFound, "role_not_found", "role not found", nil)
	}
	if body.InheritsFrom != nil && isBuiltinTarget {
		return opError(http.StatusBadRequest, "roles_inherits_immutable", "inheritsFrom is immutable on built-in roles", nil)
	}
	if body.InheritsFrom != nil && !auth.IsBuiltinRole(*body.InheritsFrom) {
		return opError(http.StatusBadRequest, "roles_inherits_invalid", "inheritsFrom must be one of viewer | editor | admin", nil)
	}
	var permissions []string
	var coerced []string
	if body.HasGrants {
		parsed, bad, ok := parsePermissions(body.GrantedPermissions)
		if !ok {
			return opError(http.StatusBadRequest, "roles_permissions_invalid", bad, nil)
		}
		permissions, coerced = auth.CoerceAdminFloor(name, parsed)
	}
	if !body.HasGrants && body.InheritsFrom == nil && body.Description == nil {
		return opError(http.StatusBadRequest, "roles_no_updatable_fields", "no updatable fields provided", nil)
	}

	action := audit.Action("org.role.updated")
	if isBuiltinTarget {
		action = "org.permissions.override_set"
	}
	var savedID string
	err = audit.WithAuditTx(ctx, s.pool, rc.authContext, func(tx pgx.Tx, txAudit audit.TxAudit) error {
		q := store.New(tx)
		if !exists {
			// First override of a built-in: create the row; built-ins
			// inherit from themselves.
			savedID = s.newID()
			var grantsJSON []byte
			if permissions != nil {
				grantsJSON, _ = json.Marshal(permissions)
			}
			description := ""
			if body.Description != nil {
				description = *body.Description
				if len(description) > 240 {
					description = description[:240]
				}
			}
			if err := q.InsertOrgRole(ctx, store.InsertOrgRoleParams{
				ID: savedID, OrgID: rc.orgID, Name: name, InheritsFrom: name,
				Description: pgtype.Text{String: description, Valid: description != ""},
				IsBuiltin:   true, GrantedPermissions: grantsJSON,
			}); err != nil {
				return err
			}
		} else {
			var grantsJSON []byte
			if permissions != nil {
				grantsJSON, _ = json.Marshal(permissions)
			}
			var inherits pgtype.Text
			if body.InheritsFrom != nil {
				inherits = pgtype.Text{String: *body.InheritsFrom, Valid: true}
			}
			var description pgtype.Text
			if body.Description != nil {
				value := *body.Description
				if len(value) > 240 {
					value = value[:240]
				}
				description = pgtype.Text{String: value, Valid: true}
			}
			updated, err := q.UpdateOrgRole(ctx, store.UpdateOrgRoleParams{
				OrgID: rc.orgID, Name: name,
				GrantedPermissions: grantsJSON, Description: description, InheritsFrom: inherits,
			})
			if err != nil {
				return err
			}
			savedID = updated.ID
		}
		metadata := map[string]any{"name": name}
		if permissions != nil {
			metadata["grantedPermissions"] = permissions
		}
		if body.InheritsFrom != nil {
			metadata["inheritsFrom"] = *body.InheritsFrom
			if exists && existing.InheritsFrom != *body.InheritsFrom {
				metadata["previousInheritsFrom"] = existing.InheritsFrom
			}
		}
		if len(coerced) > 0 {
			metadata["coerced"] = coerced
		}
		return txAudit(action, audit.Options{TargetType: "org_role", TargetID: savedID, Metadata: metadata})
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	row, err := store.New(s.pool).GetOrgRole(ctx, store.GetOrgRoleParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(roleViewFrom(row.ID, row.OrgID, row.Name, row.InheritsFrom, row.Description, row.IsBuiltin, row.GrantedPermissions))
}

func (s *V1Server) deleteRoleCore(r *http.Request, rc v1Request, rawName string) opResult {
	name := strings.ToLower(strings.TrimSpace(rawName))
	if name == "" {
		return opError(http.StatusBadRequest, "roles_name_required", "role name is required", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	existing, err := q.GetOrgRole(ctx, store.GetOrgRoleParams{OrgID: rc.orgID, Name: name})
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		}
		if auth.IsBuiltinRole(name) {
			return opError(http.StatusNotFound, "roles_override_not_found", "no override exists for this built-in role", nil)
		}
		return opError(http.StatusNotFound, "role_not_found", "role not found", nil)
	}

	if auth.IsBuiltinRole(name) {
		// Deleting a built-in's row REVERTS the override.
		err := audit.WithAuditTx(ctx, s.pool, rc.authContext, func(tx pgx.Tx, txAudit audit.TxAudit) error {
			if _, err := store.New(tx).DeleteOrgRole(ctx, store.DeleteOrgRoleParams{OrgID: rc.orgID, Name: name}); err != nil {
				return err
			}
			return txAudit("org.permissions.override_cleared", audit.Options{
				TargetType: "org_role", TargetID: existing.ID, Metadata: map[string]any{"name": name},
			})
		})
		if err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		}
		return opOK(map[string]any{"ok": true, "reverted": true})
	}

	membersAffected, err := q.CountMembersInRole(ctx, store.CountMembersInRoleParams{OrgID: rc.orgID, Role: name})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if membersAffected > 0 {
		// The contract's envelope carries membersAffected at BOTH levels.
		return opResult{status: http.StatusConflict, code: "role_in_use",
			message: "cannot delete a role with active members",
			params:  map[string]any{"membersAffected": membersAffected},
			data: map[string]any{
				"error": "cannot delete a role with active members", "code": "role_in_use",
				"params": map[string]any{"membersAffected": membersAffected}, "membersAffected": membersAffected,
			}}
	}
	err = audit.WithAuditTx(ctx, s.pool, rc.authContext, func(tx pgx.Tx, txAudit audit.TxAudit) error {
		if _, err := store.New(tx).DeleteOrgRole(ctx, store.DeleteOrgRoleParams{OrgID: rc.orgID, Name: name}); err != nil {
			return err
		}
		return txAudit("org.role.deleted", audit.Options{
			TargetType: "org_role", TargetID: existing.ID,
			Metadata: map[string]any{"name": name, "inheritsFrom": existing.InheritsFrom},
		})
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) mountRoleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /org/permissions/catalog", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.permissionsCatalogCore(r, rc))
	}))
	mux.HandleFunc("GET /org/roles", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.listRolesCore(r, rc))
	}))
	mux.HandleFunc("POST /org/roles", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.createRoleCore(r, rc))
	}))
	mux.HandleFunc("POST /org/roles/{name}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.updateRoleCore(r, rc, r.PathValue("name")))
	}))
	mux.HandleFunc("DELETE /org/roles/{name}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.deleteRoleCore(r, rc, r.PathValue("name")))
	}))
}
