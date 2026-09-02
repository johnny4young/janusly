// Recovery V2 read projections (reference recovery-routes.ts +
// recovery-metrics/ledger.ts): durable recovery cases, the constant-time
// lifetime impact ledger, and the operator's personal momentum. Reads
// ONLY — zero new authority; every projection is org-scoped and bounded.
package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/store"
)

func recoveryCaseView(row store.RecoveryCase) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "runId": row.RunID,
		"workflowId": textOrNull(row.WorkflowID), "workflowVersionId": row.WorkflowVersionID,
		"source": row.Source, "detectorId": row.DetectorID, "sourceNodeId": row.SourceNodeID,
		"detectorKind": row.DetectorKind, "action": row.Action, "message": row.Message,
		"detailsJson": rawOrNull(row.DetailsJson), "state": row.State, "revision": row.Revision,
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
	detail, err := s.engine.GetRecoveryCaseDetail(r.Context(), rc.orgID, caseID)
	if err != nil {
		if errors.Is(err, engine.ErrRecoveryCaseNotFound) {
			return opError(http.StatusNotFound, "recovery_case_not_found", "Recovery case not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	transitions := make([]map[string]any, 0, len(detail.Transitions))
	for _, row := range detail.Transitions {
		transitions = append(transitions, map[string]any{
			"id": row.ID, "orgId": row.OrgID, "caseId": row.CaseID,
			"fromState": row.FromState, "toState": row.ToState,
			"actorKind": row.ActorKind, "actorId": textOrNull(row.ActorID),
			"evidenceJson": rawOrNull(row.EvidenceJson), "reason": textOrNull(row.Reason),
			"occurredAt": row.OccurredAt,
		})
	}
	artifacts := make([]map[string]any, 0, len(detail.Artifacts))
	for _, row := range detail.Artifacts {
		artifacts = append(artifacts, recoveryArtifactView(row))
	}
	// The browser needs a durable continuity hint after refresh, not the grant
	// itself. Keep the projection HTTP-only and omit its identity/actor; apply
	// still re-checks the exact binding and consumes it through a locked CAS.
	var activeApproval any
	grant, err := store.New(s.pool).FindActiveRecoveryApprovalGrantForCase(
		r.Context(),
		store.FindActiveRecoveryApprovalGrantForCaseParams{
			OrgID: rc.orgID, CaseID: caseID,
			CaseRevision: detail.Case.Revision, NowAt: time.Now().UTC(),
		},
	)
	if err == nil {
		activeApproval = map[string]any{
			"candidateArtifactId":  grant.CandidateArtifactID,
			"validationArtifactId": grant.ValidationArtifactID,
			"caseRevision":         grant.CaseRevision,
			"expiresAt":            grant.ExpiresAt,
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(map[string]any{
		"case": recoveryCaseView(detail.Case), "transitions": transitions,
		"artifacts": artifacts, "autonomy": detail.Autonomy,
		"activeApproval": activeApproval,
	})
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(map[string]any{"recovered": recovered, "windowDays": windowDays})
}

func (s *V1Server) mountRecoveryReadRoutes(mux *http.ServeMux) {
	gate := routeGate{auth.RoleViewer, "recovery.read"}
	s.route(mux, "GET /recovery/cases", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryCasesCore(r, rc))
	})
	s.route(mux, "GET /v1/recovery/cases", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryCasesCore(r, rc))
	})
	s.route(mux, "GET /recovery/cases/{caseId}", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryCaseCore(r, rc))
	})
	s.route(mux, "GET /v1/recovery/cases/{caseId}", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryCaseCore(r, rc))
	})
	s.route(mux, "GET /recovery/ledger", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryLedgerCore(r, rc))
	})
	s.route(mux, "GET /v1/recovery/ledger", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryLedgerCore(r, rc))
	})
	s.route(mux, "GET /recovery/my-wins", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryMyWinsCore(r, rc))
	})
	s.route(mux, "GET /v1/recovery/my-wins", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.recoveryMyWinsCore(r, rc))
	})
}
