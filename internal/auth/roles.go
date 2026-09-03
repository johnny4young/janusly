// Role resolution, implements the contract's permissions ladder
// (the API contract:resolveMemberRole): the org_members row's
// literal role wins; a non-built-in literal consults org_roles for rank
// inheritance (that branch lands with the custom-roles ticket — until
// then a custom literal fails closed, which is exactly the contract's
// posture for a deleted custom role still referenced by a member); and
// ONLY dev-headers mode auto-grants admin when NO row exists — the local
// development convenience that service-token and supabase never get.
package auth

import (
	"context"
	"encoding/json"

	"github.com/johnny4young/janusly/internal/store"
)

func jsonUnmarshal(raw []byte, into any) error { return json.Unmarshal(raw, into) }

// Role is the built-in rank ladder.
type Role string

const (
	RoleViewer Role = "viewer"
	RoleEditor Role = "editor"
	RoleAdmin  Role = "admin"
)

// Rank orders the built-ins; higher clears lower requirements.
var Rank = map[Role]int{RoleViewer: 1, RoleEditor: 2, RoleAdmin: 3}

// IsBuiltinRole reports membership in the closed built-in set.
func IsBuiltinRole(name string) bool {
	_, ok := Rank[Role(name)]
	return ok
}

// ResolvedRole carries the member's role name plus its rank-equivalent
// built-in (for custom roles, the inheritsFrom).
type ResolvedRole struct {
	Name         string
	InheritsFrom Role
}

// ResolveMemberRole maps (org, user, mode) to the effective role, or nil.
func ResolveMemberRole(ctx context.Context, q *store.Queries, orgID, userID string, mode Mode) (*ResolvedRole, error) {
	membership, err := q.GetOrgMembership(ctx, store.GetOrgMembershipParams{
		OrgID: orgID, UserID: userID,
	})
	if err == nil && membership.Role != "" {
		return ResolveRoleFromMembership(ctx, q, orgID, membership.Role, mode)
	}
	if err != nil && !errorsIsNoRows(err) {
		return nil, err
	}
	return ResolveRoleFromMembership(ctx, q, orgID, "", mode)
}

// ResolveRoleFromMembership resolves a membership literal already read by the
// centralized request resolver. Authorization middleware uses this seam so it
// does not repeat the same org_members lookup for the role and permission
// checks on every request.
func ResolveRoleFromMembership(ctx context.Context, q *store.Queries, orgID, membershipRole string, mode Mode) (*ResolvedRole, error) {
	if membershipRole == "" {
		// No org_members row: the admin auto-grant exists ONLY for dev-headers.
		if mode == ModeDevHeaders {
			return &ResolvedRole{Name: string(RoleAdmin), InheritsFrom: RoleAdmin}, nil
		}
		return nil, nil
	}
	if IsBuiltinRole(membershipRole) {
		return &ResolvedRole{Name: membershipRole, InheritsFrom: Role(membershipRole)}, nil
	}
	// Custom role: rank comes from the defining org_roles row's inheritsFrom.
	// A deleted definition or invalid inheritance fails closed.
	orgRole, err := q.GetOrgRole(ctx, store.GetOrgRoleParams{
		OrgID: orgID, Name: membershipRole,
	})
	if err == nil && IsBuiltinRole(orgRole.InheritsFrom) {
		return &ResolvedRole{Name: orgRole.Name, InheritsFrom: Role(orgRole.InheritsFrom)}, nil
	}
	if err != nil && !errorsIsNoRows(err) {
		return nil, err
	}
	return nil, nil
}

// EffectivePermissions resolves the permission set for a role NAME in an
// org, org_roles-aware per the contract's lookup:
//  1. An org_roles row with NON-NULL grantedPermissions is used verbatim
//     — the override REPLACES the default set, it is not additive.
//  2. No row (or null permissions): a built-in name falls back to the
//     catalog defaults. A custom role always has a row, so a
//     null-permissions custom is a data-integrity bug → empty set
//     (fail-closed).
func EffectivePermissions(ctx context.Context, q *store.Queries, orgID string, role *ResolvedRole) (map[string]bool, error) {
	if role == nil {
		return nil, nil
	}
	row, err := q.GetOrgRole(ctx, store.GetOrgRoleParams{OrgID: orgID, Name: role.Name})
	if err == nil && len(row.GrantedPermissions) > 0 && string(row.GrantedPermissions) != "null" {
		var keys []string
		if jsonErr := jsonUnmarshal(row.GrantedPermissions, &keys); jsonErr != nil {
			return map[string]bool{}, nil // malformed grant list: fail closed
		}
		out := map[string]bool{}
		for _, key := range keys {
			if IsPermission(key) {
				out[key] = true
			}
		}
		return out, nil
	}
	if err != nil && !errorsIsNoRows(err) {
		return nil, err
	}
	if IsBuiltinRole(role.Name) || (err == nil) {
		// Built-in defaults — also the fallback for an override row whose
		// permissions are null (rank override only).
		out := map[string]bool{}
		for _, entry := range PermissionCatalog {
			if entry.DefaultRoles[role.InheritsFrom] {
				out[entry.Key] = true
			}
		}
		if !IsBuiltinRole(role.Name) && err == nil && (len(row.GrantedPermissions) == 0 || string(row.GrantedPermissions) == "null") {
			// Custom role with a row but null permissions: integrity bug,
			// fail closed per the contract.
			return map[string]bool{}, nil
		}
		return out, nil
	}
	return map[string]bool{}, nil
}
