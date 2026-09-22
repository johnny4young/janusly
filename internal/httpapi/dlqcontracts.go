package httpapi

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

// Both legacy query reads and typed entry reads share the tenant-bound snapshot.
func (s *V1Server) deadLetterDetailCore(r *http.Request, rc v1Request, id string) opResult {
	q := store.New(s.pool)
	row, err := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{ID: id, OrgID: rc.orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "dlq_not_found", "Dead letter not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	view := newDeadLetterDetailView(row)
	if run, runErr := q.GetRun(r.Context(), store.GetRunParams{ID: row.RunID, OrgID: rc.orgID}); runErr == nil {
		view.Drill = parseRecoveryDrillProvenance(run.InputJson)
		if view.Drill != nil {
			if outcome, outcomeErr := s.queryDrillOutcome(r.Context(), rc.orgID, row.ID); outcomeErr == nil {
				view.DrillOutcome = outcome
			}
		}
	}
	return opOK(view)
}

func (s *V1Server) mountDLQContractRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /v1/dlq/entries/{deadLetterId}", routeGate{auth.RoleViewer, "dlq.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.deadLetterDetailCore(r, rc, r.PathValue("deadLetterId")))
	})
	s.route(mux, "GET /dlq/entries/{deadLetterId}", routeGate{auth.RoleViewer, "dlq.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.deadLetterDetailCore(r, rc, r.PathValue("deadLetterId")))
	})
	s.route(mux, "POST /v1/dlq/resolve", routeGate{auth.RoleEditor, "recovery.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.resolveDeadLetterCore(r, rc))
	})
}
