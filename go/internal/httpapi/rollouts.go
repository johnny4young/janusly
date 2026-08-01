// Workflow deployment controls — bounded admin lifecycle over the
// baseline/canary substrate: GET /workflows/{id}/rollout (operator
// projection), POST (create with the full validation ladder), and the
// promote/rollback decision. The engine owns version compatibility,
// deterministic assignment, atomic counters, and automatic rollback.
package httpapi

import (
	"net/http"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/store"
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
	rollout, err := store.New(s.pool).GetLatestWorkflowRolloutRow(r.Context(), store.GetLatestWorkflowRolloutRowParams{
		OrgID: rc.orgID, WorkflowID: workflowID,
	})
	if err != nil {
		return opOK(map[string]any{"rollout": nil})
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
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
	_ = decodeBody(r, &body)
	kind, rollout, err := s.engine.FinishWorkflowRollout(r.Context(), rc.orgID, workflowID, rolloutID, decision, body.Reason)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
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
		writeLegacy(w, s.getRolloutCore(r, rc, r.PathValue("workflowId")))
	}))
	mux.HandleFunc("POST /workflows/{workflowId}/rollout", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.createRolloutCore(r, rc, r.PathValue("workflowId")))
	}))
	mux.HandleFunc("POST /workflows/{workflowId}/rollout/{rolloutId}/{decision}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.decideRolloutCore(r, rc, r.PathValue("workflowId"), r.PathValue("rolloutId"), r.PathValue("decision")))
	}))
}
