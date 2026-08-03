// Identity bootstrap projection consumed by the web before tenant requests.
// Provider identity is resolved separately from organization authorization so
// legitimate users with zero memberships receive a usable onboarding state.
package httpapi

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
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

func (s *V1Server) authContextCore(ctx context.Context, rc identityRequest) opResult {
	q := store.New(s.pool)
	identity := rc.identity
	rows, err := q.ListIdentityMemberships(ctx, identity.UserID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	truncated := len(rows) > identityMembershipLimit
	if truncated {
		rows = rows[:identityMembershipLimit]
	}

	organizations := make([]map[string]any, 0, len(rows)+1)
	for _, row := range rows {
		resolved, roleErr := auth.ResolveMemberRole(ctx, q, row.OrgID, identity.UserID, identity.Mode)
		if roleErr != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
		permissions, permissionErr := auth.EffectivePermissions(ctx, q, row.OrgID, resolved)
		if permissionErr != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
		permissionKeys := slices.Sorted(maps.Keys(permissions))
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
			resolved, roleErr := auth.ResolveMemberRole(ctx, q, identity.OrgHint, identity.UserID, identity.Mode)
			if roleErr != nil {
				return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
			}
			permissions, permissionErr := auth.EffectivePermissions(ctx, q, identity.OrgHint, resolved)
			if permissionErr != nil {
				return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
			}
			permissionKeys := slices.Sorted(maps.Keys(permissions))
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
	profile, profileErr := q.GetUserProfile(ctx, identity.UserID)
	if profileErr == nil {
		profileName = textOrNull(profile.Name)
		if profile.Email.Valid {
			profileEmail = profile.Email.String
		}
	} else if !errors.Is(profileErr, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}

	invitations := []map[string]any{}
	invitationsTruncated := false
	if identity.Email != "" {
		invitationRows, invitationErr := q.ListIdentityInvitations(ctx, identity.Email)
		if invitationErr != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
	return opOK(payload)
}

func (s *V1Server) authContext(w http.ResponseWriter, r *http.Request, rc identityRequest) {
	writeUnversioned(w, s.authContextCore(r.Context(), rc))
}
