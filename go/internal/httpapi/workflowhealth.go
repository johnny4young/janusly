// Workflow health rollup + recovery before/after delta (reference
// workflows-routes.ts health section). Health = the 0–100 score across
// the last 30 days of run activity plus the static readiness signal as
// the safety dimension; the delta route splits the SAME window by a
// version cutoff (before < afterVersion ≤ after) and adds the run-status
// counter, the same-failure check by normalized signature, and the
// MIN_RUNS gate so the dialog can render "gathering data" honestly.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/health"
	"github.com/johnny4young/janusly/go/internal/signature"
	"github.com/johnny4young/janusly/go/internal/store"
)

const defaultHealthWindowDays = 30

func healthSignalsFromRow(row store.QueryWorkflowHealthSignalsRow) (health.Signals, int) {
	signals := health.Signals{
		TotalRuns: int(row.TotalRuns), SuccessCount: int(row.SuccessCount),
		FailureCount: int(row.FailureCount), RetryCount: int(row.RetryCount),
		DlqOpenCount: int(row.DlqOpenCount),
		TotalCostUsd: row.TotalCostUsd, TotalTokens: row.TotalTokens,
		VersionCount: int(row.VersionCount),
	}
	// Below five terminal runs the p95 is noise — neutral instead. The
	// SQL side answers -1 when no terminal run carries a duration.
	if row.P95LatencyMs >= 0 && signals.TotalRuns >= 5 {
		value := row.P95LatencyMs
		signals.P95LatencyMs = &value
	}
	return signals, int(row.RunningCount)
}

// resolveWorkflowHealthContext loads the tenant-gated latest version, its
// parsed workflow, merged readiness issues, and the declared SLO.
func (s *V1Server) resolveWorkflowHealthContext(
	r *http.Request, rc v1Request, workflowID string,
) (*domain.Workflow, []health.ReadinessIssue, *health.Slo, *opResult) {
	ctx := r.Context()
	q := store.New(s.pool)
	fail := func(status int, code, message string) *opResult {
		res := opError(status, code, message, nil)
		return &res
	}
	owner, err := q.GetWorkflowIngestState(ctx, workflowID)
	if err != nil || owner.OrgID != rc.orgID || owner.DeletedAt != nil {
		return nil, nil, nil, fail(http.StatusNotFound, "workflow_not_found", "Workflow not found")
	}
	version, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		return nil, nil, nil, fail(http.StatusNotFound, "workflows_no_versions", "Workflow has no versions")
	}
	wf, _ := domain.Parse(version.DagJson)
	if wf == nil {
		return nil, nil, nil, fail(http.StatusUnprocessableEntity, "workflows_version_malformed", "Workflow version is malformed")
	}
	readiness := domain.CheckWorkflowReadiness(wf, s.readinessOptions())
	issues := make([]health.ReadinessIssue, 0, len(readiness.Issues))
	for _, issue := range readiness.Issues {
		issues = append(issues, health.ReadinessIssue{Code: issue.Code, Severity: issue.Severity})
	}
	for _, issue := range rollbackAvailabilityIssues(ctx, q, rc.orgID, workflowID) {
		issues = append(issues, health.ReadinessIssue{Code: issue.Code, Severity: issue.Severity})
	}

	var slo *health.Slo
	if raw, err := q.GetLatestWorkflowSlo(ctx, store.GetLatestWorkflowSloParams{
		OrgID: rc.orgID, WorkflowID: workflowID,
	}); err == nil && len(raw) > 0 && string(raw) != "null" {
		var parsed health.Slo
		if json.Unmarshal(raw, &parsed) == nil {
			slo = &parsed
		}
	}
	return wf, issues, slo, nil
}

func workflowHealthFacts(wf *domain.Workflow) health.WorkflowFacts {
	facts := health.WorkflowFacts{}
	for _, node := range wf.Nodes {
		switch node.Type {
		case "ai", "agent", "multi_agent":
			facts.AiNodeCount++
		case "approval":
			facts.HasApprovalNode = true
		}
	}
	return facts
}

func (s *V1Server) mountWorkflowHealthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /workflows/health", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.URL.Query().Get("workflowId")
		if workflowID == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "workflows_workflow_id_required", "workflowId is required", nil))
			return
		}
		wf, issues, slo, bad := s.resolveWorkflowHealthContext(r, rc, workflowID)
		if bad != nil {
			writeLegacy(w, *bad)
			return
		}
		since := time.Now().AddDate(0, 0, -defaultHealthWindowDays)
		row, err := store.New(s.pool).QueryWorkflowHealthSignals(r.Context(), store.QueryWorkflowHealthSignalsParams{
			WorkflowID: workflowID, OrgID: rc.orgID, Since: &since,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		signals, _ := healthSignalsFromRow(row)
		score := health.Compute(workflowHealthFacts(wf), issues, signals, slo)
		writeLegacy(w, opOK(map[string]any{"health": score}))
	}))

	mux.HandleFunc("GET /workflows/health/delta", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		query := r.URL.Query()
		workflowID := query.Get("workflowId")
		afterVersion, err := strconv.Atoi(query.Get("afterVersion"))
		if workflowID == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "workflows_workflow_id_required", "workflowId is required", nil))
			return
		}
		if err != nil || afterVersion < 1 {
			writeLegacy(w, opError(http.StatusBadRequest, "workflows_after_version_invalid",
				"afterVersion must be a positive integer", nil))
			return
		}
		windowDays := defaultHealthWindowDays
		if raw := query.Get("windowDays"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 30 {
				windowDays = parsed
			}
		}
		priorSignature := query.Get("priorFailureSignature")
		if len(priorSignature) > 256 {
			priorSignature = ""
		}

		wf, issues, slo, bad := s.resolveWorkflowHealthContext(r, rc, workflowID)
		if bad != nil {
			writeLegacy(w, *bad)
			return
		}
		ctx := r.Context()
		q := store.New(s.pool)
		since := time.Now().AddDate(0, 0, -windowDays)
		cutoff := int32(afterVersion)
		beforeRow, errBefore := q.QueryWorkflowHealthSignals(ctx, store.QueryWorkflowHealthSignalsParams{
			WorkflowID: workflowID, OrgID: rc.orgID, Since: &since,
			BeforeVersion: pgtype.Int4{Int32: cutoff, Valid: true},
		})
		afterRow, errAfter := q.QueryWorkflowHealthSignals(ctx, store.QueryWorkflowHealthSignalsParams{
			WorkflowID: workflowID, OrgID: rc.orgID, Since: &since,
			FromVersion: pgtype.Int4{Int32: cutoff, Valid: true},
		})
		if errBefore != nil || errAfter != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		facts := workflowHealthFacts(wf)
		beforeSignals, _ := healthSignalsFromRow(beforeRow)
		afterSignals, runningAfter := healthSignalsFromRow(afterRow)
		before := health.Compute(facts, issues, beforeSignals, slo)
		after := health.Compute(facts, issues, afterSignals, slo)

		// Same-failure check: post-cutoff dead letters whose normalized
		// signature matches the prior failure's.
		sameFailureCount := 0
		if priorSignature != "" {
			rows, err := q.ListRecentDeadLetterErrorsForWorkflow(ctx, store.ListRecentDeadLetterErrorsForWorkflowParams{
				WorkflowID: workflowID, OrgID: rc.orgID, CreatedAt: &since,
				FromVersion: pgtype.Int4{Int32: cutoff, Valid: true},
			})
			if err == nil {
				for _, errorJSON := range rows {
					if signature.NormalizeJSON(errorJSON, signature.Context{}).Signature == priorSignature {
						sameFailureCount++
					}
				}
			}
		}

		writeLegacy(w, opOK(map[string]any{
			"before": before, "after": after,
			"delta": map[string]any{
				"score":        after.Score - before.Score,
				"successCount": afterSignals.SuccessCount - beforeSignals.SuccessCount,
				"failureCount": afterSignals.FailureCount - beforeSignals.FailureCount,
				"dlqOpenCount": afterSignals.DlqOpenCount - beforeSignals.DlqOpenCount,
			},
			"runStatusCounter": map[string]any{
				"terminal": afterSignals.TotalRuns, "running": runningAfter,
			},
			"hasEnoughData":   afterSignals.TotalRuns >= health.MinRunsForDelta,
			"minRunsForDelta": health.MinRunsForDelta,
			"sameFailure": map[string]any{
				"checked":  priorSignature != "",
				"recurred": sameFailureCount > 0,
				"count":    sameFailureCount,
			},
		}))
	}))
}

// parseWorkflowSloBody validates the optional save-body `slo` block.
func parseWorkflowSloBody(raw json.RawMessage) (json.RawMessage, string) {
	var carrier struct {
		Slo *struct {
			SuccessRatePercent *float64 `json:"successRatePercent"`
			P95DurationMs      *float64 `json:"p95DurationMs"`
		} `json:"slo"`
	}
	if err := json.Unmarshal(raw, &carrier); err != nil || carrier.Slo == nil {
		return nil, ""
	}
	slo := carrier.Slo
	if slo.SuccessRatePercent != nil && (*slo.SuccessRatePercent < 0 || *slo.SuccessRatePercent > 100) {
		return nil, "slo.successRatePercent must be between 0 and 100"
	}
	if slo.P95DurationMs != nil && (*slo.P95DurationMs < 1 || *slo.P95DurationMs > 86_400_000) {
		return nil, "slo.p95DurationMs must be between 1 and 86400000"
	}
	serialized, err := json.Marshal(slo)
	if err != nil {
		return nil, "slo not serializable"
	}
	return serialized, ""
}

var _ = errors.Is
var _ = pgx.ErrNoRows
