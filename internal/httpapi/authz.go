// Route authorization gates over the auth package's ladder: requireRole
// (rank-based) now, requirePermission (catalog-based) with the annotated
// registry ticket. 403 bodies carry the contract dispatcher's exact
// message shape ("Forbidden: requires <role> role" under
// server_request_failed).
package httpapi

import (
	"net/http"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

func (s *V1Server) resolvedGateRole(r *http.Request, rc v1Request) (*auth.ResolvedRole, *opResult) {
	// Fail closed if a caller ever reaches this without a resolved auth
	// context: ModeSupabase never auto-grants a membership, unlike the
	// dev-headers mode's no-membership admin fallback.
	q := store.New(s.pool)
	var resolved *auth.ResolvedRole
	var err error
	if rc.authContext == nil {
		// Defensive and test seam: ordinary middleware always carries the
		// centralized context, but a direct core invocation must retain the
		// old fail-closed membership resolution rather than infer a role.
		resolved, err = auth.ResolveMemberRole(r.Context(), q, rc.orgID, rc.userID, auth.ModeSupabase)
	} else {
		resolved, err = auth.ResolveRoleFromMembership(
			r.Context(), q, rc.orgID, rc.authContext.MembershipRole, rc.authContext.Mode,
		)
	}
	if err != nil {
		rejection := opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		return nil, &rejection
	}
	return resolved, nil
}

// routeGate is one registry annotation: when both are set, BOTH must pass,
// role first — the contract dispatcher's order.
type routeGate struct {
	role       auth.Role
	permission string
}

func (s *V1Server) checkGate(r *http.Request, rc v1Request, gate routeGate) *opResult {
	resolved, rejection := s.resolvedGateRole(r, rc)
	if rejection != nil {
		return rejection
	}
	if gate.role != "" {
		if resolved == nil || auth.Rank[resolved.InheritsFrom] < auth.Rank[gate.role] {
			denied := opError(http.StatusForbidden, "server_request_failed",
				"Forbidden: requires "+string(gate.role)+" role", nil)
			return &denied
		}
	}
	if gate.permission != "" {
		var effective map[string]bool
		if resolved != nil {
			var err error
			effective, err = auth.EffectivePermissions(r.Context(), store.New(s.pool), rc.orgID, resolved)
			if err != nil {
				failed := opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
				return &failed
			}
		}
		if resolved == nil || !effective[gate.permission] {
			denied := opError(http.StatusForbidden, "server_request_failed",
				"Forbidden: requires permission "+gate.permission, nil)
			return &denied
		}
	}
	return nil
}
