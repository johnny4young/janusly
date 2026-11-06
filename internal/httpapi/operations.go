package httpapi

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/operations"
)

func (s *V1Server) operationsBriefCore(r *http.Request, rc v1Request) opResult {
	permissions, rejection := s.effectivePermissions(r, rc)
	if rejection != nil {
		return *rejection
	}
	humanApproval := rc.authContext != nil && rc.authContext.Mode != auth.ModeServiceToken
	brief := operations.Builder{Pool: s.pool, HumanApproval: humanApproval}.Build(r.Context(), rc.orgID, permissions)
	return opOK(brief)
}

func (s *V1Server) runInvestigationCore(r *http.Request, rc v1Request, runID string) opResult {
	permissions, rejection := s.effectivePermissions(r, rc)
	if rejection != nil {
		return *rejection
	}
	investigation, err := operations.Builder{Pool: s.pool}.Investigate(r.Context(), rc.orgID, runID, permissions)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return opError(http.StatusNotFound, "investigation_run_not_found", "Run not found", nil)
	case errors.Is(err, operations.ErrNoFailedStep):
		return opError(http.StatusConflict, "investigation_no_failed_step", "Run has no failed step", nil)
	case err != nil:
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(investigation)
}

func (s *V1Server) mountOperationsRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /v1/runs/{runId}/investigation", routeGate{auth.RoleViewer, "runs.read"},
		func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			writeVersioned(w, rc.id, s.runInvestigationCore(r, rc, r.PathValue("runId")))
		})
	s.route(mux, "GET /v1/operations/brief", routeGate{
		role: auth.RoleViewer,
	}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.operationsBriefCore(r, rc))
	})
}
