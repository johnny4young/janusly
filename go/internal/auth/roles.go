// Role resolution, ported from the reference's permissions ladder
// (apps/api/src/permissions.ts:resolveMemberRole): the org_members row's
// literal role wins; a non-built-in literal consults org_roles for rank
// inheritance (that branch lands with the custom-roles ticket — until
// then a custom literal fails closed, which is exactly the reference's
// posture for a deleted custom role still referenced by a member); and
// ONLY dev-headers mode auto-grants admin when NO row exists — the local
// development convenience that service-token and supabase never get.
package auth

import (
	"context"

	"github.com/johnny4young/janusly/go/internal/store"
)

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
		if IsBuiltinRole(membership.Role) {
			return &ResolvedRole{Name: membership.Role, InheritsFrom: Role(membership.Role)}, nil
		}
		// Custom role: the org_roles rank lookup arrives with the
		// custom-roles ticket. Until then — and permanently for a custom
		// name whose defining row was deleted — fail closed: no membership.
		return nil, nil
	}
	if err != nil && !errorsIsNoRows(err) {
		return nil, err
	}
	// No org_members row: the admin auto-grant exists ONLY for dev-headers.
	if mode == ModeDevHeaders {
		return &ResolvedRole{Name: string(RoleAdmin), InheritsFrom: RoleAdmin}, nil
	}
	return nil, nil
}
