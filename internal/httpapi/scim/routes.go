// SCIM route surface: admin CRUD on directories and
// group-role mappings, the groups picker, bulk resync, and the public
// signature-authorized WorkOS webhook receiver.
package scim

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/store"
)

/* ------------------------------- routes ----------------------------------- */

// Deps are the root package's hooks a SCIM Service needs.
type Deps struct {
	Pool   *pgxpool.Pool
	NewID  func() string
	Routes httpkit.Registrar
}

// Service serves the SCIM directory surface for one API process.
type Service struct {
	pool   *pgxpool.Pool
	newID  func() string
	routes httpkit.Registrar
}

// Mount registers the SCIM routes into mux through the root registry.
func Mount(mux *http.ServeMux, deps Deps) {
	s := &Service{pool: deps.Pool, newID: deps.NewID, routes: deps.Routes}
	s.mountRoutes(mux)
}

func scimDirectoryView(row store.ScimDirectory) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "providerDirectoryId": row.ProviderDirectoryID,
		"directoryType": httpkit.TextOrNull(row.DirectoryType), "defaultRole": row.DefaultRole,
		"status": row.Status, "lastSyncedAt": row.LastSyncedAt, "createdAt": row.CreatedAt,
	}
}

func scimGroupView(row store.ScimGroupState) map[string]any {
	return map[string]any{
		"id": row.ID, "providerGroupId": row.ProviderGroupID, "name": row.Name,
		"lastSyncedAt": row.LastSyncedAt,
	}
}

func scimMappingView(row store.ScimGroupRoleMapping) map[string]any {
	return map[string]any{
		"id": row.ID, "providerGroupId": row.ProviderGroupID, "role": row.Role,
		"scimDirectoryId": row.ScimDirectoryID, "createdBy": httpkit.TextOrNull(row.CreatedBy),
		"updatedBy": httpkit.TextOrNull(row.UpdatedBy), "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func (s *Service) getScimDirectoryForOrg(ctx context.Context, orgID string) (store.ScimDirectory, bool, error) {
	directory, err := store.New(s.pool).GetScimDirectoryByOrgID(ctx, orgID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.ScimDirectory{}, false, nil
		}
		return store.ScimDirectory{}, false, err
	}
	return directory, true, nil
}

func (s *Service) mountRoutes(mux *http.ServeMux) {
	// === Admin CRUD on scim_directories ===
	s.routes.Route(mux, "GET /org/scim/directories", httpkit.Gate{Role: auth.RoleViewer, Permission: "members.read"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.getOrgScimDirectoriesCore(r, rc))
	})

	s.routes.Route(mux, "POST /org/scim/directories", httpkit.Gate{Role: auth.RoleAdmin, Permission: "org.config.write"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.postOrgScimDirectoriesCore(r, rc))
	})

	s.routes.Route(mux, "POST /org/scim/directories/{id}", httpkit.Gate{Role: auth.RoleAdmin, Permission: "org.config.write"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.updateOrgScimDirectoryCore(r, rc))
	})

	s.routes.Route(mux, "DELETE /org/scim/directories/{id}", httpkit.Gate{Role: auth.RoleAdmin, Permission: "org.config.write"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.deleteOrgScimDirectoriesCore(r, rc))
	})

	// === Synced groups (read-only; backs the mapping picker) ===
	s.routes.Route(mux, "GET /org/scim/groups", httpkit.Gate{Role: auth.RoleViewer, Permission: "members.read"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.getOrgScimGroupsCore(r, rc))
	})

	// === Admin CRUD on scim_group_role_mappings ===
	s.routes.Route(mux, "GET /org/scim/group-role-mappings", httpkit.Gate{Role: auth.RoleViewer, Permission: "members.read"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.getOrgScimGroupRoleMappingsCore(r, rc))
	})

	s.routes.Route(mux, "POST /org/scim/group-role-mappings", httpkit.Gate{Role: auth.RoleAdmin, Permission: "members.role_set"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.postOrgScimGroupRoleMappingsCore(r, rc))
	})

	s.routes.Route(mux, "POST /org/scim/group-role-mappings/{id}", httpkit.Gate{Role: auth.RoleAdmin, Permission: "members.role_set"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.updateOrgScimGroupRoleMappingCore(r, rc))
	})

	s.routes.Route(mux, "DELETE /org/scim/group-role-mappings/{id}", httpkit.Gate{Role: auth.RoleAdmin, Permission: "members.role_set"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.deleteOrgScimGroupRoleMappingsCore(r, rc))
	})

	// === Bulk role re-sync ===
	s.routes.Route(mux, "POST /org/scim/resync", httpkit.Gate{Role: auth.RoleAdmin, Permission: "members.role_set"}, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.postOrgScimResyncCore(r, rc))
	})

	// === Webhook receiver (public; signature-authorized) ===
	mux.HandleFunc("POST /webhooks/workos/directory", s.scimWebhookHandler)
}

/* --------------------------------- resync --------------------------------- */

// resyncScimMemberRoles applies the CURRENT group→role mappings to every
// active member of the directory on demand instead of waiting for each
// user's next inbound event. It reuses the SAME derivation the webhook
// handlers run — a re-sync only ever writes the role the next event would
// have produced. invited_by is deliberately NOT passed so the original
// provisioning actor survives. Per-member failures are isolated (skipped).
func (s *Service) resyncScimMemberRoles(ctx context.Context, directory store.ScimDirectory) (map[string]any, error) {
	q := store.New(s.pool)
	// Over-fetch cap+1 to distinguish a truncated sweep from one that
	// exactly fills the cap.
	fetched, err := q.ListActiveScimUserState(ctx, store.ListActiveScimUserStateParams{
		OrgID: directory.OrgID, ScimDirectoryID: directory.ID, Limit: scimResyncMaxMembers + 1,
	})
	if err != nil {
		return nil, err
	}
	mappings, err := s.scimGroupRoleMappingsMap(ctx, directory)
	if err != nil {
		return nil, err
	}
	capped := len(fetched) > scimResyncMaxMembers
	members := fetched
	if capped {
		members = fetched[:scimResyncMaxMembers]
	}
	resynced, changed, skipped := 0, 0, 0
	changes := []map[string]any{}
	for _, member := range members {
		lowerEmail := strings.ToLower(member.Email)
		groupIDs, err := q.ListScimUserGroupIDs(ctx, store.ListScimUserGroupIDsParams{
			OrgID: directory.OrgID, ScimDirectoryID: directory.ID, ProviderUserID: member.ProviderUserID,
		})
		if err != nil {
			skipped++
			continue
		}
		newRole := deriveScimRole(groupIDs, mappings, directory.DefaultRole)
		var currentRole any
		if row, err := q.FindScimMemberByEmail(ctx, store.FindScimMemberByEmailParams{
			OrgID: directory.OrgID, Email: pgtype.Text{String: lowerEmail, Valid: true},
		}); err == nil {
			currentRole = row.Role
		} else if !errors.Is(err, pgx.ErrNoRows) {
			skipped++
			continue
		}
		if err := s.upsertScimMembership(ctx, directory.OrgID, lowerEmail, newRole, ""); err != nil {
			skipped++
			continue
		}
		resynced++
		if currentRole != newRole {
			changed++
			changes = append(changes, map[string]any{
				"providerUserId": member.ProviderUserID, "email": lowerEmail,
				"from": currentRole, "to": newRole,
			})
		}
	}
	return map[string]any{
		"membersResynced": resynced, "membersChanged": changed,
		"skipped": skipped, "capped": capped, "changes": changes,
	}, nil
}

func (s *Service) getOrgScimDirectoriesCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	rows, err := store.New(s.pool).ListScimDirectories(r.Context(), rc.OrgID)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	views := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		views = append(views, scimDirectoryView(row))
	}
	return httpkit.OK(map[string]any{"directories": views})

}

func (s *Service) postOrgScimDirectoriesCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	var body struct {
		ProviderDirectoryID string `json:"providerDirectoryId"`
		DirectoryType       string `json:"directoryType"`
		DefaultRole         string `json:"defaultRole"`
	}
	if err := httpkit.DecodeBody(r, &body); err != nil {
		return httpkit.Error(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil)
	}
	providerDirectoryID := strings.TrimSpace(body.ProviderDirectoryID)
	if providerDirectoryID == "" {
		return httpkit.Error(http.StatusBadRequest, "scim_provider_directory_id_required",
			"providerDirectoryId is required (e.g. directory_…)", nil)
	}
	defaultRole := "viewer"
	if body.DefaultRole != "" {
		if !isScimBuiltinRole(body.DefaultRole) {
			return httpkit.Error(http.StatusBadRequest, "scim_default_role_invalid",
				"defaultRole must be viewer | editor | admin", nil)
		}
		defaultRole = body.DefaultRole
	}
	if _, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.OrgID); err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	} else if attached {
		return httpkit.Error(http.StatusConflict, "scim_directory_already_attached",
			"SCIM directory already attached for this org", nil)
	}
	row, err := store.New(s.pool).InsertScimDirectory(r.Context(), store.InsertScimDirectoryParams{
		ID: s.newID(), OrgID: rc.OrgID, ProviderDirectoryID: providerDirectoryID,
		DirectoryType: pgtype.Text{String: body.DirectoryType, Valid: body.DirectoryType != ""},
		DefaultRole:   defaultRole,
	})
	if err != nil {
		if httpkit.IsUniqueViolation(err) {
			return httpkit.Error(http.StatusConflict, "scim_directory_already_attached",
				"SCIM directory already attached", nil)
		}
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.Auth, "org.scim.directory_attached", audit.Options{
		TargetType: "scim_directory", TargetID: row.ID,
		Metadata: map[string]any{
			"providerDirectoryId": providerDirectoryID,
			"directoryType":       httpkit.TextOrNull(row.DirectoryType), "defaultRole": defaultRole,
		},
	})
	return httpkit.OK(map[string]any{"directory": scimDirectoryView(row)})

}

func (s *Service) updateOrgScimDirectoryCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	var body struct {
		DefaultRole *string `json:"defaultRole"`
		Status      *string `json:"status"`
	}
	if err := httpkit.DecodeBody(r, &body); err != nil {
		return httpkit.Error(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil)
	}
	if body.Status != nil {
		return httpkit.Error(http.StatusBadRequest, "scim_directory_status_immutable",
			"use DELETE /org/scim/directories/{id} to revoke a directory", nil)
	}
	if body.DefaultRole == nil {
		return httpkit.Error(http.StatusBadRequest, "scim_no_updatable_fields",
			"no updatable fields provided", nil)
	}
	if !isScimBuiltinRole(*body.DefaultRole) {
		return httpkit.Error(http.StatusBadRequest, "scim_default_role_invalid",
			"defaultRole must be viewer | editor | admin", nil)
	}
	row, err := store.New(s.pool).UpdateScimDirectoryDefaultRole(r.Context(), store.UpdateScimDirectoryDefaultRoleParams{
		ID: r.PathValue("id"), OrgID: rc.OrgID, DefaultRole: *body.DefaultRole,
	})
	if err != nil {
		return httpkit.Error(http.StatusNotFound, "scim_directory_not_found", "SCIM directory not found", nil)
	}
	audit.Write(r.Context(), s.pool, rc.Auth, "org.scim.directory_updated", audit.Options{
		TargetType: "scim_directory", TargetID: row.ID,
		Metadata: map[string]any{"defaultRole": *body.DefaultRole},
	})
	return httpkit.OK(map[string]any{"directory": scimDirectoryView(row)})

}

func (s *Service) deleteOrgScimDirectoriesCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	rows, err := store.New(s.pool).RevokeScimDirectory(r.Context(), store.RevokeScimDirectoryParams{
		ID: r.PathValue("id"), OrgID: rc.OrgID,
	})
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if rows == 0 {
		return httpkit.Error(http.StatusNotFound, "scim_directory_not_found", "SCIM directory not found", nil)
	}
	audit.Write(r.Context(), s.pool, rc.Auth, "org.scim.directory_revoked", audit.Options{
		TargetType: "scim_directory", TargetID: r.PathValue("id"),
	})
	return httpkit.OK(map[string]any{"ok": true})

}

func (s *Service) getOrgScimGroupsCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.OrgID)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if !attached {
		return httpkit.OK(map[string]any{"groups": []map[string]any{}})
	}
	limit := scimGroupStateDefaultLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = min(parsed, scimGroupStateMaxLimit)
		}
	}
	rows, err := store.New(s.pool).ListScimGroupState(r.Context(), store.ListScimGroupStateParams{
		OrgID: rc.OrgID, ScimDirectoryID: directory.ID, Limit: int32(limit),
	})
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	views := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		views = append(views, scimGroupView(row))
	}
	return httpkit.OK(map[string]any{"groups": views})

}

func (s *Service) getOrgScimGroupRoleMappingsCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.OrgID)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	views := []map[string]any{}
	if attached {
		rows, err := store.New(s.pool).ListScimGroupRoleMappings(r.Context(), store.ListScimGroupRoleMappingsParams{
			OrgID: rc.OrgID, ScimDirectoryID: directory.ID,
		})
		if err != nil {
			return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
		for _, row := range rows {
			views = append(views, scimMappingView(row))
		}
	}
	return httpkit.OK(map[string]any{"mappings": views})

}

func (s *Service) postOrgScimGroupRoleMappingsCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	var body struct {
		ProviderGroupID string `json:"providerGroupId"`
		Role            string `json:"role"`
	}
	if err := httpkit.DecodeBody(r, &body); err != nil {
		return httpkit.Error(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil)
	}
	directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.OrgID)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if !attached {
		return httpkit.Error(http.StatusConflict, "scim_directory_required_for_mappings",
			"attach a SCIM directory before configuring group role mappings", nil)
	}
	providerGroupID := strings.TrimSpace(body.ProviderGroupID)
	if providerGroupID == "" {
		return httpkit.Error(http.StatusBadRequest, "scim_provider_group_id_required",
			"providerGroupId is required (e.g. directory_group_…)", nil)
	}
	if !isScimBuiltinRole(body.Role) {
		return httpkit.Error(http.StatusBadRequest, "scim_role_invalid",
			"role must be viewer | editor | admin", nil)
	}
	q := store.New(s.pool)
	// The group must exist in synced state — guards typo'd /
	// cross-directory ids that would silently never match.
	if _, err := q.GetScimGroupState(r.Context(), store.GetScimGroupStateParams{
		ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
	}); err != nil {
		return httpkit.Error(http.StatusNotFound, "scim_unknown_provider_group_id",
			"unknown providerGroupId for this directory", nil)
	}
	if _, err := q.FindScimGroupRoleMappingByGroup(r.Context(), store.FindScimGroupRoleMappingByGroupParams{
		OrgID: rc.OrgID, ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
	}); err == nil {
		return httpkit.Error(http.StatusConflict, "scim_group_role_mapping_exists",
			"a mapping for this group already exists; update it instead", nil)
	}
	row, err := q.InsertScimGroupRoleMapping(r.Context(), store.InsertScimGroupRoleMappingParams{
		ID: s.newID(), OrgID: rc.OrgID, ScimDirectoryID: directory.ID,
		ProviderGroupID: providerGroupID, Role: body.Role,
		CreatedBy: pgtype.Text{String: rc.UserID, Valid: rc.UserID != ""},
	})
	if err != nil {
		if httpkit.IsUniqueViolation(err) {
			return httpkit.Error(http.StatusConflict, "scim_group_role_mapping_exists",
				"a mapping for this group already exists; update it instead", nil)
		}
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.Auth, "org.scim.group_role_mapping_created", audit.Options{
		TargetType: "scim_group_role_mapping", TargetID: row.ID,
		Metadata: map[string]any{
			"providerGroupId": providerGroupID, "role": body.Role, "scimDirectoryId": directory.ID,
		},
	})
	return httpkit.OK(map[string]any{"mapping": scimMappingView(row)})

}

func (s *Service) updateOrgScimGroupRoleMappingCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	var body struct {
		Role string `json:"role"`
	}
	if err := httpkit.DecodeBody(r, &body); err != nil || !isScimBuiltinRole(body.Role) {
		return httpkit.Error(http.StatusBadRequest, "scim_role_invalid",
			"role must be viewer | editor | admin", nil)
	}
	q := store.New(s.pool)
	existing, err := q.GetScimGroupRoleMappingByID(r.Context(), store.GetScimGroupRoleMappingByIDParams{
		ID: r.PathValue("id"), OrgID: rc.OrgID,
	})
	if err != nil {
		return httpkit.Error(http.StatusNotFound, "scim_group_role_mapping_not_found",
			"group role mapping not found", nil)
	}
	row, err := q.UpdateScimGroupRoleMappingRole(r.Context(), store.UpdateScimGroupRoleMappingRoleParams{
		ID: existing.ID, OrgID: rc.OrgID, Role: body.Role,
		UpdatedBy: pgtype.Text{String: rc.UserID, Valid: rc.UserID != ""},
	})
	if err != nil {
		return httpkit.Error(http.StatusNotFound, "scim_group_role_mapping_not_found",
			"group role mapping not found", nil)
	}
	audit.Write(r.Context(), s.pool, rc.Auth, "org.scim.group_role_mapping_updated", audit.Options{
		TargetType: "scim_group_role_mapping", TargetID: existing.ID,
		Metadata: map[string]any{
			"providerGroupId": existing.ProviderGroupID,
			"before":          existing.Role, "after": body.Role,
			"scimDirectoryId": existing.ScimDirectoryID,
		},
	})
	return httpkit.OK(map[string]any{"mapping": scimMappingView(row)})

}

func (s *Service) deleteOrgScimGroupRoleMappingsCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	q := store.New(s.pool)
	existing, err := q.GetScimGroupRoleMappingByID(r.Context(), store.GetScimGroupRoleMappingByIDParams{
		ID: r.PathValue("id"), OrgID: rc.OrgID,
	})
	if err != nil {
		return httpkit.Error(http.StatusNotFound, "scim_group_role_mapping_not_found",
			"group role mapping not found", nil)
	}
	if _, err := q.DeleteScimGroupRoleMapping(r.Context(), store.DeleteScimGroupRoleMappingParams{
		ID: existing.ID, OrgID: rc.OrgID,
	}); err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.Auth, "org.scim.group_role_mapping_deleted", audit.Options{
		TargetType: "scim_group_role_mapping", TargetID: existing.ID,
		Metadata: map[string]any{
			"providerGroupId": existing.ProviderGroupID, "role": existing.Role,
			"scimDirectoryId": existing.ScimDirectoryID,
		},
	})
	return httpkit.OK(map[string]any{"ok": true})

}

func (s *Service) postOrgScimResyncCore(r *http.Request, rc httpkit.Request) httpkit.Result {
	directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.OrgID)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if !attached {
		return httpkit.Error(http.StatusConflict, "scim_directory_required_for_resync",
			"attach a SCIM directory before re-syncing roles", nil)
	}
	result, err := s.resyncScimMemberRoles(r.Context(), directory)
	if err != nil {
		return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.Auth, "org.scim.resynced", audit.Options{
		TargetType: "scim_directory", TargetID: directory.ID,
		Metadata: map[string]any{
			"membersResynced": result["membersResynced"], "membersChanged": result["membersChanged"],
			"skipped": result["skipped"], "capped": result["capped"], "scimDirectoryId": directory.ID,
		},
	})
	return httpkit.OK(result)

}
