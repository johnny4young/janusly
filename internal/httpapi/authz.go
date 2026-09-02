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
		rejection := opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
		effective, failed := s.permissionsForResolvedRole(r, rc, resolved)
		if failed != nil {
			return failed
		}
		if resolved == nil || !effective[gate.permission] {
			denied := opError(http.StatusForbidden, "server_request_failed",
				"Forbidden: requires permission "+gate.permission, nil)
			return &denied
		}
	}
	return nil
}

// effectivePermissions is the single projection used by handlers whose
// response itself is permission-sensitive (for example Operator Brief
// allowedActions). It deliberately shares the same role-resolution path as
// the route gate so custom roles and built-in overrides cannot drift between
// authorization and returned capability hints.
func (s *V1Server) effectivePermissions(r *http.Request, rc v1Request) (map[string]bool, *opResult) {
	resolved, rejection := s.resolvedGateRole(r, rc)
	if rejection != nil {
		return nil, rejection
	}
	return s.permissionsForResolvedRole(r, rc, resolved)
}

func (s *V1Server) permissionsForResolvedRole(
	r *http.Request,
	rc v1Request,
	resolved *auth.ResolvedRole,
) (map[string]bool, *opResult) {
	if resolved == nil {
		return map[string]bool{}, nil
	}
	effective, err := auth.EffectivePermissions(r.Context(), store.New(s.pool), rc.orgID, resolved)
	if err != nil {
		failed := opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		return nil, &failed
	}
	return effective, nil
}
