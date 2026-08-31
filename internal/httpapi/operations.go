package httpapi

import (
	"net/http"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/operations"
)

func (s *V1Server) operationsBriefCore(r *http.Request, rc v1Request) opResult {
	permissions, rejection := s.effectivePermissions(r, rc)
	if rejection != nil {
		return *rejection
	}
	brief := operations.Builder{Pool: s.pool}.Build(r.Context(), rc.orgID, permissions)
	return opOK(brief)
}

func (s *V1Server) mountOperationsRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /v1/operations/brief", routeGate{
		role: auth.RoleViewer, permission: "recovery.read",
	}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.operationsBriefCore(r, rc))
	})
}
