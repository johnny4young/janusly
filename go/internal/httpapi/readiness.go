// Production-readiness surface: the deterministic gate on run start
// (JANUSLY_PRODUCTION_MODE=true → fail-level issues reject with 422) and
// the badge route POST /workflows/readiness the studio polls. Same engine
// check for both, layered with the DB-side rollback-availability warn —
// mirroring the reference's split (pure engine rules + API-layered issues).
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/store"
)

// readinessOptions wires the pure checks' seams: the tool registry's static
// write-side bit and the opt-in eval-coverage warn.
func (s *V1Server) readinessOptions() domain.ReadinessOptions {
	registry := executors.NewToolRegistry()
	return domain.ReadinessOptions{
		IsWriteSideTool: func(tool string, _ map[string]any) bool {
			return registry.IsWriteSide(tool)
		},
		RequireEvalCoverage: os.Getenv("JANUSLY_REQUIRE_EVAL_COVERAGE") == "true",
	}
}

// rollbackAvailabilityIssues is the DB-layered warn: fewer than two saved
// versions means a future regression has nothing to roll back to. Unsaved
// (ad-hoc) workflows skip the check — there are no version rows to count.
func rollbackAvailabilityIssues(ctx context.Context, q *store.Queries, orgID, workflowID string) []domain.ReadinessIssue {
	if workflowID == "" {
		return nil
	}
	count, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		OrgID: orgID, WorkflowID: workflowID,
	})
	if err != nil || count >= 2 {
		return nil
	}
	return []domain.ReadinessIssue{{
		Code: "workflow_missing_rollback_version", Severity: "warn",
		Message:    "Only one workflow version exists. If a future save introduces a regression there is no prior version to roll back to.",
		Suggestion: "Save the workflow at least once more (or duplicate the current version) so the runtime improvement path can roll back if confidence drops.",
	}}
}

func mergeReadiness(base domain.ReadinessResult, extra []domain.ReadinessIssue) domain.ReadinessResult {
	issues := append(append([]domain.ReadinessIssue{}, base.Issues...), extra...)
	status := base.Status
	for _, issue := range extra {
		if issue.Severity == "fail" {
			status = "fail"
		} else if issue.Severity == "warn" && status == "pass" {
			status = "warn"
		}
	}
	return domain.ReadinessResult{Status: status, Issues: issues}
}

// productionGate returns a non-nil rejection when the production-mode env
// is set and the workflow carries fail-level readiness issues. Dev mode
// (env unset) keeps existing behaviour — anything structurally valid runs.
func (s *V1Server) productionGate(ctx context.Context, orgID string, wf *domain.Workflow) *opResult {
	if os.Getenv("JANUSLY_PRODUCTION_MODE") != "true" {
		return nil
	}
	readiness := domain.CheckWorkflowReadiness(wf, s.readinessOptions())
	rollback := rollbackAvailabilityIssues(ctx, store.New(s.pool), orgID, wf.ID)
	merged := mergeReadiness(readiness, rollback)
	if merged.Status != "fail" {
		return nil
	}
	rejection := opError(http.StatusUnprocessableEntity, "runs_not_production_ready",
		"Workflow not production-ready", nil)
	return &rejection
}

// readinessCore serves POST /workflows/readiness (both wires): the badge's
// structural-validation-plus-readiness projection. Structurally invalid
// workflows return a fail result (HTTP 200) with each validation issue
// wrapped as `invalid_workflow_<code>` — the badge renders them in place.
func (s *V1Server) readinessCore(r *http.Request, rc v1Request) opResult {
	var body map[string]json.RawMessage
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	candidate, ok := body["workflow"]
	if !ok || len(candidate) == 0 {
		full, err := json.Marshal(body)
		if err != nil {
			return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
		}
		candidate = full
	}
	wf, _ := domain.Parse(candidate)
	var validation domain.ValidationResult
	if wf != nil {
		validation = domain.Validate(wf, grammar.DomainValidator)
	}
	if wf == nil || !validation.Valid {
		issues := make([]domain.ReadinessIssue, 0, len(validation.Issues))
		for _, issue := range validation.Issues {
			issues = append(issues, domain.ReadinessIssue{
				Code: "invalid_workflow_" + issue.Code, Severity: "fail",
				Message: issue.Message, NodeID: issue.NodeID, EdgeID: issue.EdgeID,
			})
		}
		return opOK(map[string]any{"status": "fail", "issues": issues})
	}
	readiness := domain.CheckWorkflowReadiness(wf, s.readinessOptions())
	rollback := rollbackAvailabilityIssues(r.Context(), store.New(s.pool), rc.orgID, wf.ID)
	merged := mergeReadiness(readiness, rollback)
	return opOK(map[string]any{"status": merged.Status, "issues": merged.Issues})
}
