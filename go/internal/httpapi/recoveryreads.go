// Recovery V2 read projections (T-518; reference recovery-routes.ts +
// recovery-metrics/ledger.ts): durable recovery cases, the constant-time
// lifetime impact ledger, and the operator's personal momentum. Reads
// ONLY — zero new authority; every projection is org-scoped and bounded.
package httpapi

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

func recoveryCaseView(row store.RecoveryCase) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "runId": row.RunID,
		"workflowId": textOrNull(row.WorkflowID), "workflowVersionId": row.WorkflowVersionID,
		"source": row.Source, "detectorId": row.DetectorID, "sourceNodeId": row.SourceNodeID,
		"detectorKind": row.DetectorKind, "action": row.Action, "message": row.Message,
		"detailsJson": rawOrNull(row.DetailsJson), "state": row.State,
		"createdBy": textOrNull(row.CreatedBy),
		"createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
		"resolvedAt": row.ResolvedAt,
	}
}

func (s *V1Server) recoveryCasesCore(r *http.Request, rc v1Request) opResult {
	query := r.URL.Query()
	limit := 100
	if raw, err := strconv.Atoi(query.Get("limit")); err == nil {
		limit = min(max(raw, 1), 200)
	}
	runID := query.Get("runId")
	rows, err := store.New(s.pool).ListRecoveryCases(r.Context(), store.ListRecoveryCasesParams{
		OrgID:     rc.orgID,
		RunID:     pgtype.Text{String: runID, Valid: runID != ""},
		OpenOnly:  query.Get("openOnly") != "false",
		PageLimit: int32(limit),
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	cases := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		cases = append(cases, recoveryCaseView(row))
	}
	return opOK(map[string]any{"cases": cases})
}

func (s *V1Server) recoveryCaseCore(r *http.Request, rc v1Request) opResult {
	caseID := r.PathValue("caseId")
	if caseID == "" {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid recovery case id", nil)
	}
	row, err := store.New(s.pool).GetRecoveryCase(r.Context(), store.GetRecoveryCaseParams{
		OrgID: rc.orgID, ID: caseID,
	})
	if err != nil {
		return opError(http.StatusNotFound, "recovery_case_not_found", "Recovery case not found", nil)
	}
	return opOK(recoveryCaseView(row))
}

func (s *V1Server) recoveryLedgerCore(r *http.Request, rc v1Request) opResult {
	// Constant-time projection: one rollup row per tenant; a missing row
	// reads as the zero ledger, never an error.
	response := map[string]any{"totalRecovered": 0, "downtimeEndedMs": 0, "sinceIso": nil}
	if row, err := store.New(s.pool).GetRecoveryImpactRollup(r.Context(), rc.orgID); err == nil {
		response["totalRecovered"] = max(row.TotalRecovered, 0)
		response["downtimeEndedMs"] = max(row.DowntimeEndedMs, 0)
		if row.FirstRecoveredAt != nil {
			response["sinceIso"] = row.FirstRecoveredAt.UTC().Format(time.RFC3339Nano)
		}
	}
	return opOK(response)
}

func (s *V1Server) recoveryMyWinsCore(r *http.Request, rc v1Request) opResult {
	// Identity comes exclusively from the auth context — the route accepts
	// no user id from the caller.
	windowDays := 30
	if raw, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil {
		windowDays = min(max(raw, 1), 90)
	}
	since := time.Now().Add(-time.Duration(windowDays) * 24 * time.Hour)
	recovered, err := store.New(s.pool).CountOperatorRecoveries(r.Context(), store.CountOperatorRecoveriesParams{
		OrgID: rc.orgID, UserID: pgtype.Text{String: rc.userID, Valid: true}, Since: since,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{"recovered": recovered, "windowDays": windowDays})
}

func (s *V1Server) mountRecoveryReadRoutes(mux *http.ServeMux) {
	gate := routeGate{auth.RoleViewer, "recovery.read"}
	s.route(mux, "GET /recovery/cases", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.recoveryCasesCore(r, rc))
	})
	s.route(mux, "GET /v1/recovery/cases", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryCasesCore(r, rc))
	})
	s.route(mux, "GET /recovery/cases/{caseId}", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.recoveryCaseCore(r, rc))
	})
	s.route(mux, "GET /v1/recovery/cases/{caseId}", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryCaseCore(r, rc))
	})
	s.route(mux, "GET /recovery/ledger", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.recoveryLedgerCore(r, rc))
	})
	s.route(mux, "GET /v1/recovery/ledger", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryLedgerCore(r, rc))
	})
	s.route(mux, "GET /recovery/my-wins", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.recoveryMyWinsCore(r, rc))
	})
	s.route(mux, "GET /v1/recovery/my-wins", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryMyWinsCore(r, rc))
	})
}
