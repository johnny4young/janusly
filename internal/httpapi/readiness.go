// Production-readiness surface: the deterministic gate on run start
// (JANUSLY_ENV=production → fail-level issues reject with 422) and
// the badge route POST /workflows/readiness the studio polls. Same engine
// check for both, layered with the DB-side rollback-availability warn —
// mirroring the contract's split (pure engine rules + API-layered issues).
package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/workflowreadiness"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

// readinessOptions wires the pure checks' seams: the tool registry's static
// write-side bit and the opt-in eval-coverage warn.
func (s *V1Server) readinessOptions() domain.ReadinessOptions {
	return workflowreadiness.Options()
}

// validateCore serves POST /validate: the contract's structural
// validation surface — {valid, issues} verbatim from domain.Validate,
// accepting a flat workflow JSON or the {workflow} envelope. No runtime
// node-type carve-out here: /validate reports the FULL issue list (the
// save path owns the carve-out decision).
func (s *V1Server) validateCore(r *http.Request, rc v1Request) opResult { //nolint:unparam // handler cores share the (r, rc) signature
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
	wf, parseIssues := domain.Parse(candidate)
	if wf == nil {
		issues := parseIssues
		if len(issues) == 0 {
			issues = []domain.Issue{{Code: domain.CodeInvalidContract, Message: "workflow: invalid document"}}
		}
		return opOK(map[string]any{"valid": false, "issues": issues})
	}
	result := workflowvalidation.Validate(wf)
	issues := result.Issues
	if issues == nil {
		issues = []domain.Issue{}
	}
	return opOK(map[string]any{"valid": result.Valid, "issues": issues})
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
		validation = workflowvalidation.Validate(wf)
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
	readiness, err := workflowreadiness.Evaluate(r.Context(), s.pool, rc.orgID, wf)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(map[string]any{"status": readiness.Status, "issues": readiness.Issues})
}
