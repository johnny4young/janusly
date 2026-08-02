// Identity bootstrap projection consumed by the web before tenant requests.
// Provider identity is resolved separately from organization authorization so
// legitimate users with zero memberships receive a usable onboarding state.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

const (
	identityMembershipLimit = 200
	identityInvitationLimit = 50
)

func identityEmail(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func displayName(value, fallback string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return fallback
}

func (s *V1Server) authContext(w http.ResponseWriter, r *http.Request, rc identityRequest) {
	q := store.New(s.pool)
	identity := rc.identity
	rows, err := q.ListIdentityMemberships(r.Context(), identity.UserID)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	truncated := len(rows) > identityMembershipLimit
	if truncated {
		rows = rows[:identityMembershipLimit]
	}

	organizations := make([]map[string]any, 0, len(rows)+1)
	for _, row := range rows {
		resolved, roleErr := auth.ResolveMemberRole(r.Context(), q, row.OrgID, identity.UserID, identity.Mode)
		if roleErr != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		permissions, permissionErr := auth.EffectivePermissions(r.Context(), q, row.OrgID, resolved)
		if permissionErr != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		permissionKeys := make([]string, 0, len(permissions))
		for key := range permissions {
			permissionKeys = append(permissionKeys, key)
		}
		sort.Strings(permissionKeys)
		roleName, roleBase := row.Role, any(nil)
		if resolved != nil {
			roleName, roleBase = resolved.Name, string(resolved.InheritsFrom)
		}
		organizations = append(organizations, map[string]any{
			"id": row.OrgID, "name": displayName(row.OrganizationName.String, row.OrgID),
			"plan": textOrNull(row.OrganizationPlan), "role": roleName,
			"roleBase": roleBase, "permissions": permissionKeys,
			"usable": resolved != nil, "developmentFallback": false,
		})
	}

	if identity.Mode == auth.ModeDevHeaders && identity.OrgHint != "" {
		found := false
		for _, organization := range organizations {
			if organization["id"] == identity.OrgHint {
				found = true
				break
			}
		}
		if !found {
			resolved, roleErr := auth.ResolveMemberRole(r.Context(), q, identity.OrgHint, identity.UserID, identity.Mode)
			if roleErr != nil {
				writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			permissions, permissionErr := auth.EffectivePermissions(r.Context(), q, identity.OrgHint, resolved)
			if permissionErr != nil {
				writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			permissionKeys := make([]string, 0, len(permissions))
			for key := range permissions {
				permissionKeys = append(permissionKeys, key)
			}
			sort.Strings(permissionKeys)
			roleName, roleBase := "admin", "admin"
			if resolved != nil {
				roleName, roleBase = resolved.Name, string(resolved.InheritsFrom)
			}
			organizations = append([]map[string]any{{
				"id": identity.OrgHint, "name": identity.OrgHint, "plan": nil,
				"role": roleName, "roleBase": roleBase, "permissions": permissionKeys,
				"usable": true, "developmentFallback": true,
			}}, organizations...)
		}
	}

	profileName, profileEmail := any(nil), identityEmail(identity.Email)
	profile, profileErr := q.GetUserProfile(r.Context(), identity.UserID)
	if profileErr == nil {
		profileName = textOrNull(profile.Name)
		if profile.Email.Valid {
			profileEmail = profile.Email.String
		}
	} else if !errors.Is(profileErr, pgx.ErrNoRows) {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}

	invitations := []map[string]any{}
	invitationsTruncated := false
	if identity.Email != "" {
		invitationRows, invitationErr := q.ListIdentityInvitations(r.Context(), identity.Email)
		if invitationErr != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		invitationsTruncated = len(invitationRows) > identityInvitationLimit
		if invitationsTruncated {
			invitationRows = invitationRows[:identityInvitationLimit]
		}
		invitations = make([]map[string]any, 0, len(invitationRows))
		for _, invitation := range invitationRows {
			invitations = append(invitations, map[string]any{
				"id": invitation.ID, "organizationId": invitation.OrgID,
				"organizationName": displayName(invitation.OrganizationName.String, invitation.OrgID),
				"role":             invitation.Role,
			})
		}
	}

	var currentOrganizationID any
	usableCount := 0
	var onlyUsable string
	for _, organization := range organizations {
		if organization["usable"] != true {
			continue
		}
		usableCount++
		onlyUsable = organization["id"].(string)
		if organization["id"] == identity.OrgHint {
			currentOrganizationID = identity.OrgHint
		}
	}
	if currentOrganizationID == nil && usableCount == 1 {
		currentOrganizationID = onlyUsable
	}

	payload := map[string]any{
		"identity": map[string]any{
			"userId": identity.UserID, "email": identityEmail(identity.Email),
			"mode": string(identity.Mode), "source": string(identity.Source),
		},
		"profile":       map[string]any{"name": profileName, "email": profileEmail},
		"organizations": organizations, "invitations": invitations,
		"currentOrganizationId": currentOrganizationID,
		"selectionRequired":     currentOrganizationID == nil && usableCount > 1,
		"needsOrganization":     usableCount == 0,
		"truncated":             truncated, "invitationsTruncated": invitationsTruncated,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}
