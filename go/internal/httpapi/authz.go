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
