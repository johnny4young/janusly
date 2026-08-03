// SCIM route surface: admin CRUD on directories and
// group-role mappings, the groups picker, bulk resync, and the public
// signature-authorized WorkOS webhook receiver.
package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/store"
)

/* ------------------------------- routes ----------------------------------- */

func scimDirectoryView(row store.ScimDirectory) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "providerDirectoryId": row.ProviderDirectoryID,
		"directoryType": textOrNull(row.DirectoryType), "defaultRole": row.DefaultRole,
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
		"scimDirectoryId": row.ScimDirectoryID, "createdBy": textOrNull(row.CreatedBy),
		"updatedBy": textOrNull(row.UpdatedBy), "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func (s *V1Server) getScimDirectoryForOrg(ctx context.Context, orgID string) (store.ScimDirectory, bool, error) {
	directory, err := store.New(s.pool).GetScimDirectoryByOrgID(ctx, orgID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.ScimDirectory{}, false, nil
		}
		return store.ScimDirectory{}, false, err
	}
	return directory, true, nil
}

func (s *V1Server) mountScimRoutes(mux *http.ServeMux) {
	// === Admin CRUD on scim_directories ===
	mux.HandleFunc("GET /org/scim/directories", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).ListScimDirectories(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, scimDirectoryView(row))
		}
		writeLegacy(w, opOK(map[string]any{"directories": views}))
	}))

	mux.HandleFunc("POST /org/scim/directories", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			ProviderDirectoryID string `json:"providerDirectoryId"`
			DirectoryType       string `json:"directoryType"`
			DefaultRole         string `json:"defaultRole"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil))
			return
		}
		providerDirectoryID := strings.TrimSpace(body.ProviderDirectoryID)
		if providerDirectoryID == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_provider_directory_id_required",
				"providerDirectoryId is required (e.g. directory_…)", nil))
			return
		}
		defaultRole := "viewer"
		if body.DefaultRole != "" {
			if !isScimBuiltinRole(body.DefaultRole) {
				writeLegacy(w, opError(http.StatusBadRequest, "scim_default_role_invalid",
					"defaultRole must be viewer | editor | admin", nil))
				return
			}
			defaultRole = body.DefaultRole
		}
		if _, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID); err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		} else if attached {
			writeLegacy(w, opError(http.StatusConflict, "scim_directory_already_attached",
				"SCIM directory already attached for this org", nil))
			return
		}
		row, err := store.New(s.pool).InsertScimDirectory(r.Context(), store.InsertScimDirectoryParams{
			ID: s.newID(), OrgID: rc.orgID, ProviderDirectoryID: providerDirectoryID,
			DirectoryType: pgtype.Text{String: body.DirectoryType, Valid: body.DirectoryType != ""},
			DefaultRole:   defaultRole,
		})
		if err != nil {
			if isUniqueViolation(err) {
				writeLegacy(w, opError(http.StatusConflict, "scim_directory_already_attached",
					"SCIM directory already attached", nil))
				return
			}
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.directory_attached", audit.Options{
			TargetType: "scim_directory", TargetID: row.ID,
			Metadata: map[string]any{
				"providerDirectoryId": providerDirectoryID,
				"directoryType":       textOrNull(row.DirectoryType), "defaultRole": defaultRole,
			},
		})
		writeLegacy(w, opOK(map[string]any{"directory": scimDirectoryView(row)}))
	}))

	mux.HandleFunc("POST /org/scim/directories/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			DefaultRole *string `json:"defaultRole"`
			Status      *string `json:"status"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil))
			return
		}
		if body.Status != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_directory_status_immutable",
				"use DELETE /org/scim/directories/{id} to revoke a directory", nil))
			return
		}
		if body.DefaultRole == nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_no_updatable_fields",
				"no updatable fields provided", nil))
			return
		}
		if !isScimBuiltinRole(*body.DefaultRole) {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_default_role_invalid",
				"defaultRole must be viewer | editor | admin", nil))
			return
		}
		row, err := store.New(s.pool).UpdateScimDirectoryDefaultRole(r.Context(), store.UpdateScimDirectoryDefaultRoleParams{
			ID: r.PathValue("id"), OrgID: rc.orgID, DefaultRole: *body.DefaultRole,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_directory_not_found", "SCIM directory not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.directory_updated", audit.Options{
			TargetType: "scim_directory", TargetID: row.ID,
			Metadata: map[string]any{"defaultRole": *body.DefaultRole},
		})
		writeLegacy(w, opOK(map[string]any{"directory": scimDirectoryView(row)}))
	}))

	mux.HandleFunc("DELETE /org/scim/directories/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).RevokeScimDirectory(r.Context(), store.RevokeScimDirectoryParams{
			ID: r.PathValue("id"), OrgID: rc.orgID,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if rows == 0 {
			writeLegacy(w, opError(http.StatusNotFound, "scim_directory_not_found", "SCIM directory not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.directory_revoked", audit.Options{
			TargetType: "scim_directory", TargetID: r.PathValue("id"),
		})
		writeLegacy(w, opOK(map[string]any{"ok": true}))
	}))

	// === Synced groups (read-only; backs the mapping picker) ===
	mux.HandleFunc("GET /org/scim/groups", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if !attached {
			writeLegacy(w, opOK(map[string]any{"groups": []map[string]any{}}))
			return
		}
		limit := scimGroupStateDefaultLimit
		if raw := r.URL.Query().Get("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = min(parsed, scimGroupStateMaxLimit)
			}
		}
		rows, err := store.New(s.pool).ListScimGroupState(r.Context(), store.ListScimGroupStateParams{
			OrgID: rc.orgID, ScimDirectoryID: directory.ID, Limit: int32(limit),
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, scimGroupView(row))
		}
		writeLegacy(w, opOK(map[string]any{"groups": views}))
	}))

	// === Admin CRUD on scim_group_role_mappings ===
	mux.HandleFunc("GET /org/scim/group-role-mappings", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := []map[string]any{}
		if attached {
			rows, err := store.New(s.pool).ListScimGroupRoleMappings(r.Context(), store.ListScimGroupRoleMappingsParams{
				OrgID: rc.orgID, ScimDirectoryID: directory.ID,
			})
			if err != nil {
				writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			for _, row := range rows {
				views = append(views, scimMappingView(row))
			}
		}
		writeLegacy(w, opOK(map[string]any{"mappings": views}))
	}))

	mux.HandleFunc("POST /org/scim/group-role-mappings", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			ProviderGroupID string `json:"providerGroupId"`
			Role            string `json:"role"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil))
			return
		}
		directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if !attached {
			writeLegacy(w, opError(http.StatusConflict, "scim_directory_required_for_mappings",
				"attach a SCIM directory before configuring group role mappings", nil))
			return
		}
		providerGroupID := strings.TrimSpace(body.ProviderGroupID)
		if providerGroupID == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_provider_group_id_required",
				"providerGroupId is required (e.g. directory_group_…)", nil))
			return
		}
		if !isScimBuiltinRole(body.Role) {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_role_invalid",
				"role must be viewer | editor | admin", nil))
			return
		}
		q := store.New(s.pool)
		// The group must exist in synced state — guards typo'd /
		// cross-directory ids that would silently never match.
		if _, err := q.GetScimGroupState(r.Context(), store.GetScimGroupStateParams{
			ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
		}); err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_unknown_provider_group_id",
				"unknown providerGroupId for this directory", nil))
			return
		}
		if _, err := q.FindScimGroupRoleMappingByGroup(r.Context(), store.FindScimGroupRoleMappingByGroupParams{
			OrgID: rc.orgID, ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
		}); err == nil {
			writeLegacy(w, opError(http.StatusConflict, "scim_group_role_mapping_exists",
				"a mapping for this group already exists; update it instead", nil))
			return
		}
		row, err := q.InsertScimGroupRoleMapping(r.Context(), store.InsertScimGroupRoleMappingParams{
			ID: s.newID(), OrgID: rc.orgID, ScimDirectoryID: directory.ID,
			ProviderGroupID: providerGroupID, Role: body.Role,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			if isUniqueViolation(err) {
				writeLegacy(w, opError(http.StatusConflict, "scim_group_role_mapping_exists",
					"a mapping for this group already exists; update it instead", nil))
				return
			}
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.group_role_mapping_created", audit.Options{
			TargetType: "scim_group_role_mapping", TargetID: row.ID,
			Metadata: map[string]any{
				"providerGroupId": providerGroupID, "role": body.Role, "scimDirectoryId": directory.ID,
			},
		})
		writeLegacy(w, opOK(map[string]any{"mapping": scimMappingView(row)}))
	}))

	mux.HandleFunc("POST /org/scim/group-role-mappings/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			Role string `json:"role"`
		}
		if err := decodeBody(r, &body); err != nil || !isScimBuiltinRole(body.Role) {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_role_invalid",
				"role must be viewer | editor | admin", nil))
			return
		}
		q := store.New(s.pool)
		existing, err := q.GetScimGroupRoleMappingByID(r.Context(), store.GetScimGroupRoleMappingByIDParams{
			ID: r.PathValue("id"), OrgID: rc.orgID,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_group_role_mapping_not_found",
				"group role mapping not found", nil))
			return
		}
		row, err := q.UpdateScimGroupRoleMappingRole(r.Context(), store.UpdateScimGroupRoleMappingRoleParams{
			ID: existing.ID, OrgID: rc.orgID, Role: body.Role,
			UpdatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_group_role_mapping_not_found",
				"group role mapping not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.group_role_mapping_updated", audit.Options{
			TargetType: "scim_group_role_mapping", TargetID: existing.ID,
			Metadata: map[string]any{
				"providerGroupId": existing.ProviderGroupID,
				"before":          existing.Role, "after": body.Role,
				"scimDirectoryId": existing.ScimDirectoryID,
			},
		})
		writeLegacy(w, opOK(map[string]any{"mapping": scimMappingView(row)}))
	}))

	mux.HandleFunc("DELETE /org/scim/group-role-mappings/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		q := store.New(s.pool)
		existing, err := q.GetScimGroupRoleMappingByID(r.Context(), store.GetScimGroupRoleMappingByIDParams{
			ID: r.PathValue("id"), OrgID: rc.orgID,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_group_role_mapping_not_found",
				"group role mapping not found", nil))
			return
		}
		if _, err := q.DeleteScimGroupRoleMapping(r.Context(), store.DeleteScimGroupRoleMappingParams{
			ID: existing.ID, OrgID: rc.orgID,
		}); err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.group_role_mapping_deleted", audit.Options{
			TargetType: "scim_group_role_mapping", TargetID: existing.ID,
			Metadata: map[string]any{
				"providerGroupId": existing.ProviderGroupID, "role": existing.Role,
				"scimDirectoryId": existing.ScimDirectoryID,
			},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true}))
	}))

	// === Bulk role re-sync ===
	mux.HandleFunc("POST /org/scim/resync", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if !attached {
			writeLegacy(w, opError(http.StatusConflict, "scim_directory_required_for_resync",
				"attach a SCIM directory before re-syncing roles", nil))
			return
		}
		result, err := s.resyncScimMemberRoles(r.Context(), directory)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.resynced", audit.Options{
			TargetType: "scim_directory", TargetID: directory.ID,
			Metadata: map[string]any{
				"membersResynced": result["membersResynced"], "membersChanged": result["membersChanged"],
				"skipped": result["skipped"], "capped": result["capped"], "scimDirectoryId": directory.ID,
			},
		})
		writeLegacy(w, opOK(result))
	}))

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
func (s *V1Server) resyncScimMemberRoles(ctx context.Context, directory store.ScimDirectory) (map[string]any, error) {
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
