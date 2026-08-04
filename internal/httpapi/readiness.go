// Production-readiness surface: the deterministic gate on run start
// (JANUSLY_ENV=production → fail-level issues reject with 422) and
// the badge route POST /workflows/readiness the studio polls. Same engine
// check for both, layered with the DB-side rollback-availability warn —
// mirroring the contract's split (pure engine rules + API-layered issues).
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/johnny4young/janusly/internal/config"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
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

// productionGate returns a non-nil rejection when JANUSLY_ENV=production and
// the workflow carries fail-level readiness issues. Development keeps the
// structurally-valid workflow posture.
func (s *V1Server) productionGate(ctx context.Context, orgID string, wf *domain.Workflow) *opResult {
	if !config.IsProduction(nil) {
		return nil
	}
	readiness := domain.CheckWorkflowReadiness(wf, s.readinessOptions())
	rollback := rollbackAvailabilityIssues(ctx, store.New(s.pool), orgID, wf.ID)
	credentialIssues := s.credentialReadinessIssues(ctx, orgID, wf)
	merged := mergeReadiness(readiness, append(rollback, credentialIssues...))
	if merged.Status != "fail" {
		return nil
	}
	rejection := opError(http.StatusUnprocessableEntity, "runs_not_production_ready",
		"Workflow not production-ready", nil)
	return &rejection
}

// validateCore serves POST /validate: the contract's structural
// validation surface — {valid, issues} verbatim from domain.Validate,
// accepting a flat workflow JSON or the {workflow} envelope. No runtime
// node-type carve-out here: /validate reports the FULL issue list (the
// save path owns the carve-out decision).
func (s *V1Server) validateCore(r *http.Request, rc v1Request) opResult {
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
	result := domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation)
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
		validation = domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation)
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
	credentialIssues := s.credentialReadinessIssues(r.Context(), rc.orgID, wf)
	merged := mergeReadiness(readiness, append(rollback, credentialIssues...))
	return opOK(map[string]any{"status": merged.Status, "issues": merged.Issues})
}

// readinessCredentialRefCap is the strict upper bound on distinct
// credential names + MCP aliases resolved per readiness pass.
const readinessCredentialRefCap = 50

// credentialReadinessIssues performs one DAG pass that collects
// distinct credential names + MCP aliases (combined cap 50 — checked
// after each potential insert so a node carrying both can't sneak past
// the bound by 1), then each unique reference resolves AT MOST once
// through the same org-aware resolver runtime integrations use. Every
// issue is warn-level `credential_missing` per referencing node.
func (s *V1Server) credentialReadinessIssues(ctx context.Context, orgID string, wf *domain.Workflow) []domain.ReadinessIssue {
	credentialRefs := map[string][]string{}
	aliasRefs := map[string][]string{}
	capped := func() bool { return len(credentialRefs)+len(aliasRefs) >= readinessCredentialRefCap }
	for _, node := range wf.Nodes {
		if capped() {
			break
		}
		if name := credentialNameFromConfig(node.Config); name != "" {
			if _, known := credentialRefs[name]; known || !capped() {
				credentialRefs[name] = append(credentialRefs[name], node.ID)
			}
		}
		if alias, ok := node.Config["connectionAlias"].(string); ok && alias != "" {
			if _, known := aliasRefs[alias]; known || !capped() {
				aliasRefs[alias] = append(aliasRefs[alias], node.ID)
			}
		}
	}
	if len(credentialRefs) == 0 && len(aliasRefs) == 0 {
		return nil
	}
	q := store.New(s.pool)
	var issues []domain.ReadinessIssue
	pushIssue := func(nodeIDs []string, message, suggestion string) {
		for _, nodeID := range nodeIDs {
			issues = append(issues, domain.ReadinessIssue{
				Code: "credential_missing", Severity: "warn",
				Message: message, NodeID: nodeID, Suggestion: suggestion,
			})
		}
	}
	if len(credentialRefs) > 0 {
		rows, err := q.ListCredentials(ctx, orgID)
		if err == nil {
			secretRefByName := map[string]string{}
			for _, row := range rows {
				secretRefByName[row.Name] = row.SecretRef
			}
			for name, nodeIDs := range credentialRefs {
				secretRef, exists := secretRefByName[name]
				if !exists {
					pushIssue(nodeIDs,
						"Credential \""+name+"\" is referenced by this workflow but no matching credential exists for this organization.",
						"Register the credential in the admin UI before this workflow runs in production.")
					continue
				}
				if !secretstore.HasCredentialSecretRef(ctx, q, orgID, secretRef) {
					pushIssue(nodeIDs,
						"Credential \""+name+"\" has no resolvable secret in this environment.",
						"Verify the credential has an active managed value or a resolvable legacy environment reference before the run starts.")
				}
			}
		}
	}
	if len(aliasRefs) > 0 {
		connections, err := q.ListMcpConnectionsForHealth(ctx, orgID)
		if err == nil {
			byAlias := map[string]store.ListMcpConnectionsForHealthRow{}
			for _, connection := range connections {
				byAlias[connection.Alias] = connection
			}
			for alias, nodeIDs := range aliasRefs {
				connection, exists := byAlias[alias]
				if !exists {
					pushIssue(nodeIDs,
						"MCP connection \""+alias+"\" is referenced by this workflow but no matching connection exists for this organization.",
						"Register the MCP connection in the admin UI before this workflow runs in production.")
					continue
				}
				var refs map[string]struct {
					Kind string `json:"kind"`
					Name string `json:"name"`
				}
				_ = json.Unmarshal(connection.EnvRefs, &refs)
				missing, total := 0, 0
				for _, ref := range refs {
					total++
					if !secretstore.HasCredentialSecretRef(ctx, q, orgID, ref.Name) {
						missing++
					}
				}
				if missing > 0 {
					pushIssue(nodeIDs,
						fmt.Sprintf("MCP connection %q has env references whose secrets don't resolve in this environment (%d of %d).", alias, missing, total),
						"Verify the legacy environment references listed in the MCP connection settings are set before this workflow runs in production.")
				}
			}
		}
	}
	return issues
}
