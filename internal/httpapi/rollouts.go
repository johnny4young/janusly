// Workflow deployment controls — bounded admin lifecycle over the
// baseline/canary substrate: GET /workflows/{id}/rollout (operator
// projection), POST (create with the full validation ladder), and the
// promote/rollback decision. The engine owns version compatibility,
// deterministic assignment, atomic counters, and automatic rollback.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

func rolloutView(rollout store.WorkflowRollout) map[string]any {
	return map[string]any{
		"id": rollout.ID, "workflowId": rollout.WorkflowID,
		"baselineVersionId": rollout.BaselineVersionID, "canaryVersionId": rollout.CanaryVersionID,
		"trafficPercent":            rollout.TrafficPercent,
		"minimumSampleSize":         rollout.MinimumSampleSize,
		"minimumSuccessRatePercent": rollout.MinimumSuccessRatePercent,
		"status":                    rollout.Status,
		"baselineSucceeded":         rollout.BaselineSucceeded, "baselineFailed": rollout.BaselineFailed,
		"canarySucceeded": rollout.CanarySucceeded, "canaryFailed": rollout.CanaryFailed,
		"rolledBackReason": textOrNull(rollout.RolledBackReason),
		"createdAt":        rollout.CreatedAt, "updatedAt": rollout.UpdatedAt,
		"endedAt": timeOrNull(rollout.EndedAt), "lastOutcomeAt": timeOrNull(rollout.LastOutcomeAt),
	}
}

func (s *V1Server) getRolloutCore(r *http.Request, rc v1Request, workflowID string) opResult {
	// Bounded read-repair: receipts missed by a crash window converge on
	// the next operator read (cron wiring lands with the scheduler wave).
	_ = s.engine.RepairWorkflowRolloutOutcomes(r.Context(), 100)
	rollout, err := store.New(s.pool).GetLatestWorkflowRolloutRow(r.Context(), store.GetLatestWorkflowRolloutRowParams{
		OrgID: rc.orgID, WorkflowID: workflowID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opOK(map[string]any{"rollout": nil})
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(map[string]any{"rollout": rolloutView(rollout)})
}

func (s *V1Server) createRolloutCore(r *http.Request, rc v1Request, workflowID string) opResult {
	var body struct {
		BaselineVersionID         string `json:"baselineVersionId"`
		CanaryVersionID           string `json:"canaryVersionId"`
		TrafficPercent            int    `json:"trafficPercent"`
		MinimumSampleSize         int    `json:"minimumSampleSize"`
		MinimumSuccessRatePercent int    `json:"minimumSuccessRatePercent"`
	}
	if err := decodeBody(r, &body); err != nil || body.BaselineVersionID == "" || body.CanaryVersionID == "" {
		return opError(http.StatusBadRequest, "workflow_rollout_invalid",
			"Workflow rollout settings are invalid", nil)
	}
	kind, rollout, err := s.engine.CreateWorkflowRollout(r.Context(), struct {
		OrgID, WorkflowID, BaselineVersionID, CanaryVersionID        string
		TrafficPercent, MinimumSampleSize, MinimumSuccessRatePercent int
		CreatedBy                                                    string
	}{
		OrgID: rc.orgID, WorkflowID: workflowID,
		BaselineVersionID: body.BaselineVersionID, CanaryVersionID: body.CanaryVersionID,
		TrafficPercent:    body.TrafficPercent,
		MinimumSampleSize: body.MinimumSampleSize, MinimumSuccessRatePercent: body.MinimumSuccessRatePercent,
		CreatedBy: rc.userID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	switch kind {
	case engine.RolloutNotFound:
		return opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
	case engine.RolloutActiveExists:
		return opError(http.StatusConflict, "workflow_rollout_active",
			"This workflow already has an active rollout", nil)
	case engine.RolloutQualificationRequired:
		return opError(http.StatusConflict, "workflow_recovery_qualification_required",
			"Pass the semantic outcome dataset comparison before starting this rollout", nil)
	case engine.RolloutCreated:
	default:
		return opError(http.StatusUnprocessableEntity, "workflow_rollout_invalid",
			"Workflow versions are not eligible for a rollout", map[string]any{"reason": string(kind)})
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "workflow.rollout.started", audit.Options{
		TargetType: "workflow_rollout", TargetID: rollout.ID,
		Metadata: map[string]any{
			"workflowId":        workflowID,
			"baselineVersionId": rollout.BaselineVersionID, "canaryVersionId": rollout.CanaryVersionID,
			"trafficPercent":            rollout.TrafficPercent,
			"minimumSampleSize":         rollout.MinimumSampleSize,
			"minimumSuccessRatePercent": rollout.MinimumSuccessRatePercent,
		},
	})
	return opOK(map[string]any{"rollout": rolloutView(*rollout)})
}

func (s *V1Server) decideRolloutCore(r *http.Request, rc v1Request, workflowID, rolloutID, decision string) opResult {
	if decision != "promote" && decision != "rollback" {
		return opError(http.StatusBadRequest, "workflow_rollout_invalid",
			"Workflow rollout path is invalid", nil)
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "workflow_rollout_invalid", "Invalid request body", nil)
	}
	kind, rollout, err := s.engine.FinishWorkflowRollout(r.Context(), rc.orgID, workflowID, rolloutID, decision, body.Reason)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	switch kind {
	case engine.RolloutFinishNotFound:
		return opError(http.StatusNotFound, "workflow_rollout_not_found", "Workflow rollout not found", nil)
	case engine.RolloutFinishInactive:
		return opError(http.StatusConflict, "workflow_rollout_not_active",
			"Workflow rollout is no longer active", nil)
	}
	auditName := "workflow.rollout.rolled_back"
	if decision == "promote" {
		auditName = "workflow.rollout.promoted"
	}
	audit.Write(r.Context(), s.pool, rc.authContext, audit.Action(auditName), audit.Options{
		TargetType: "workflow_rollout", TargetID: rollout.ID,
		Metadata: map[string]any{
			"workflowId":        workflowID,
			"baselineVersionId": rollout.BaselineVersionID, "canaryVersionId": rollout.CanaryVersionID,
			"reason": textOrNull(rollout.RolledBackReason),
		},
	})
	return opOK(map[string]any{"rollout": rolloutView(*rollout)})
}

func (s *V1Server) mountRolloutRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /workflows/{workflowId}/rollout", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.getRolloutCore(r, rc, r.PathValue("workflowId")))
	}))
	mux.HandleFunc("POST /workflows/{workflowId}/rollout", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.createRolloutCore(r, rc, r.PathValue("workflowId")))
	}))
	mux.HandleFunc("POST /workflows/{workflowId}/rollout/{rolloutId}/{decision}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.decideRolloutCore(r, rc, r.PathValue("workflowId"), r.PathValue("rolloutId"), r.PathValue("decision")))
	}))
	mux.HandleFunc("GET /workflows/{workflowId}/rollout/qualification", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.getQualificationCore(r, rc, r.PathValue("workflowId")))
	}))
	mux.HandleFunc("POST /workflows/{workflowId}/rollout/qualification", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recordQualificationCore(r, rc, r.PathValue("workflowId")))
	}))
}

func qualificationView(row store.WorkflowRecoveryQualification) map[string]any {
	return map[string]any{
		"id": row.ID, "workflowId": row.WorkflowID,
		"baselineVersionId": row.BaselineVersionID, "candidateVersionId": row.CandidateVersionID,
		"datasetVersion": row.DatasetVersion, "datasetDigest": row.DatasetDigest,
		"mode": row.Mode, "status": row.Status,
		"summary": json.RawMessage(row.SummaryJson), "createdAt": row.CreatedAt,
	}
}

// resolveQualificationVersions loads + orders the exact version pair.
func (s *V1Server) resolveQualificationVersions(r *http.Request, rc v1Request, workflowID, baselineID, candidateID string) (*domain.Workflow, *domain.Workflow, *opResult) {
	q := store.New(s.pool)
	if _, err := q.GetWorkflow(r.Context(), store.GetWorkflowParams{ID: workflowID, OrgID: rc.orgID}); err != nil {
		status, code, message := http.StatusInternalServerError, "internal_error", "Internal error"
		if errors.Is(err, pgx.ErrNoRows) {
			status, code, message = http.StatusNotFound, "workflow_not_found", "Workflow not found"
		}
		res := opError(status, code, message, nil)
		return nil, nil, &res
	}
	versions, err := q.ListWorkflowVersionsForRollout(r.Context(), store.ListWorkflowVersionsForRolloutParams{
		OrgID: rc.orgID, WorkflowID: workflowID,
	})
	if err != nil {
		res := opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		return nil, nil, &res
	}
	var baseline, candidate *store.ListWorkflowVersionsForRolloutRow
	for i := range versions {
		if versions[i].ID == baselineID {
			baseline = &versions[i]
		}
		if versions[i].ID == candidateID {
			candidate = &versions[i]
		}
	}
	if baseline == nil || candidate == nil || baseline.Version >= candidate.Version {
		res := opError(http.StatusUnprocessableEntity, "workflow_recovery_qualification_invalid",
			"Workflow versions are not eligible for qualification", map[string]any{"reason": "invalid_versions"})
		return nil, nil, &res
	}
	baselineWorkflow, _ := domain.Parse(baseline.DagJson)
	candidateWorkflow, _ := domain.Parse(candidate.DagJson)
	if baselineWorkflow == nil || candidateWorkflow == nil {
		res := opError(http.StatusUnprocessableEntity, "workflow_recovery_qualification_invalid",
			"Workflow versions are not eligible for qualification", map[string]any{"reason": "invalid_versions"})
		return nil, nil, &res
	}
	return baselineWorkflow, candidateWorkflow, nil
}

func qualificationRequired(baseline, candidate *domain.Workflow) bool {
	isV2 := func(wf *domain.Workflow) bool {
		return wf.Recovery != nil && wf.Recovery.Contract != nil && wf.Recovery.Contract.Version == "2"
	}
	return isV2(baseline) || isV2(candidate)
}

func (s *V1Server) getQualificationCore(r *http.Request, rc v1Request, workflowID string) opResult {
	baselineID := r.URL.Query().Get("baselineVersionId")
	candidateID := r.URL.Query().Get("candidateVersionId")
	if baselineID == "" || candidateID == "" {
		return opError(http.StatusBadRequest, "workflow_recovery_qualification_invalid",
			"Recovery qualification version pair is invalid", nil)
	}
	baseline, candidate, bad := s.resolveQualificationVersions(r, rc, workflowID, baselineID, candidateID)
	if bad != nil {
		return *bad
	}
	if !qualificationRequired(baseline, candidate) {
		return opOK(map[string]any{"required": false, "qualification": nil})
	}
	row, err := store.New(s.pool).FindWorkflowRecoveryQualification(r.Context(), store.FindWorkflowRecoveryQualificationParams{
		OrgID: rc.orgID, WorkflowID: workflowID,
		BaselineVersionID: baselineID, CandidateVersionID: candidateID,
		DatasetVersion: engine.RecoveryQualificationDatasetVersion,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opOK(map[string]any{"required": true, "qualification": nil})
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(map[string]any{"required": true, "qualification": qualificationView(row)})
}

func (s *V1Server) recordQualificationCore(r *http.Request, rc v1Request, workflowID string) opResult {
	var body struct {
		BaselineVersionID  string `json:"baselineVersionId"`
		CandidateVersionID string `json:"candidateVersionId"`
	}
	if err := decodeBody(r, &body); err != nil || body.BaselineVersionID == "" || body.CandidateVersionID == "" {
		return opError(http.StatusBadRequest, "workflow_recovery_qualification_invalid",
			"Recovery qualification version pair is invalid", nil)
	}
	baseline, candidate, bad := s.resolveQualificationVersions(r, rc, workflowID, body.BaselineVersionID, body.CandidateVersionID)
	if bad != nil {
		return *bad
	}
	summary := recovery.QualifyRecoveryCandidate(baseline, candidate)
	if summary.Status == "not_required" {
		return opOK(map[string]any{"required": false, "qualification": nil, "summary": summary})
	}
	receiptJSON, _ := json.Marshal(recovery.ToReceiptSummary(summary))
	row, err := store.New(s.pool).UpsertWorkflowRecoveryQualification(r.Context(), store.UpsertWorkflowRecoveryQualificationParams{
		ID: s.newID(), OrgID: rc.orgID, WorkflowID: workflowID,
		BaselineVersionID: body.BaselineVersionID, CandidateVersionID: body.CandidateVersionID,
		DatasetVersion: summary.DatasetVersion, DatasetDigest: summary.DatasetDigest,
		Mode: summary.Mode, Status: summary.Status,
		SummaryJson: receiptJSON, CreatedBy: rc.userID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "workflow.recovery_qualification.recorded", audit.Options{
		TargetType: "workflow_recovery_qualification", TargetID: row.ID,
		Metadata: map[string]any{
			"workflowId":        workflowID,
			"baselineVersionId": body.BaselineVersionID, "candidateVersionId": body.CandidateVersionID,
			"datasetVersion": summary.DatasetVersion, "datasetDigest": summary.DatasetDigest,
			"mode": summary.Mode, "status": summary.Status,
			"candidateAssertionCount":   summary.CandidateAssertionCount,
			"failedCandidateAssertions": summary.FailedCandidateAssertions,
			"regressionCount":           summary.RegressionCount,
		},
	})
	return opOK(map[string]any{"required": true, "qualification": qualificationView(row)})
}
