// Route authorization gates over the auth package's ladder: requireRole
// (rank-based) now, requirePermission (catalog-based) with the annotated
// registry ticket. 403 bodies carry the reference dispatcher's exact
// message shape ("Forbidden: requires <role> role" under
// server_request_failed).
package httpapi

import (
	"net/http"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

// requireRole resolves the caller's effective role and enforces the rank.
// Returns nil when allowed; an opResult rejection otherwise.
func (s *V1Server) requireRole(r *http.Request, rc v1Request, required auth.Role) *opResult {
	mode := auth.ModeDevHeaders
	if rc.authContext != nil {
		mode = rc.authContext.Mode
	}
	resolved, err := auth.ResolveMemberRole(r.Context(), store.New(s.pool), rc.orgID, rc.userID, mode)
	if err != nil {
		rejection := opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		return &rejection
	}
	if resolved == nil || auth.Rank[resolved.InheritsFrom] < auth.Rank[required] {
		rejection := opError(http.StatusForbidden, "server_request_failed",
			"Forbidden: requires "+string(required)+" role", nil)
		return &rejection
	}
	return nil
}

// requirePermission enforces the catalog layer after the rank layer, with
// the reference's verbatim 403 ("Forbidden: requires permission <key>").
func (s *V1Server) requirePermission(r *http.Request, rc v1Request, permission string) *opResult {
	mode := auth.ModeDevHeaders
	if rc.authContext != nil {
		mode = rc.authContext.Mode
	}
	resolved, err := auth.ResolveMemberRole(r.Context(), store.New(s.pool), rc.orgID, rc.userID, mode)
	if err != nil {
		rejection := opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		return &rejection
	}
	var effective map[string]bool
	if resolved != nil {
		effective, err = auth.EffectivePermissions(r.Context(), store.New(s.pool), rc.orgID, resolved)
		if err != nil {
			rejection := opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
			return &rejection
		}
	}
	if resolved == nil || !effective[permission] {
		rejection := opError(http.StatusForbidden, "server_request_failed",
			"Forbidden: requires permission "+permission, nil)
		return &rejection
	}
	return nil
}

// routeGate is one registry annotation: when both are set, BOTH must pass,
// role first — the reference dispatcher's order.
type routeGate struct {
	role       auth.Role
	permission string
}

func (s *V1Server) checkGate(r *http.Request, rc v1Request, gate routeGate) *opResult {
	if gate.role != "" {
		if rejection := s.requireRole(r, rc, gate.role); rejection != nil {
			return rejection
		}
	}
	if gate.permission != "" {
		if rejection := s.requirePermission(r, rc, gate.permission); rejection != nil {
			return rejection
		}
	}
	return nil
}
