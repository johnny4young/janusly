package mcpserver

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

const maxAssuranceIssueCodes = 50

type assuranceIssueView struct {
	Code     string `json:"code"`
	Severity string `json:"severity,omitempty"`
}

func validationIssueViews(issues []domain.Issue) []assuranceIssueView {
	views := make([]assuranceIssueView, 0, min(len(issues), maxAssuranceIssueCodes))
	seen := map[string]bool{}
	for _, issue := range issues {
		if issue.Code == "" || seen[issue.Code] {
			continue
		}
		seen[issue.Code] = true
		views = append(views, assuranceIssueView{Code: issue.Code})
		if len(views) == maxAssuranceIssueCodes {
			break
		}
	}
	return views
}

func readinessIssueViews(issues []domain.ReadinessIssue) []assuranceIssueView {
	views := make([]assuranceIssueView, 0, min(len(issues), maxAssuranceIssueCodes))
	seen := map[string]bool{}
	for _, issue := range issues {
		key := issue.Code + "\x00" + issue.Severity
		if issue.Code == "" || seen[key] {
			continue
		}
		seen[key] = true
		views = append(views, assuranceIssueView{Code: issue.Code, Severity: issue.Severity})
		if len(views) == maxAssuranceIssueCodes {
			break
		}
	}
	return views
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func assuranceProjection(wf *domain.Workflow, validation domain.ValidationResult) map[string]any {
	readiness := domain.CheckWorkflowReadiness(wf, domain.ReadinessOptions{})
	inputFields := []string{}
	if wf.Inputs != nil {
		inputFields = sortedKeys(wf.Inputs.Properties)
	}
	outputFields := sortedKeys(wf.Outputs)

	intent := map[string]any{
		"declared":    len(outputFields) > 0,
		"inputFields": inputFields, "outputFields": outputFields,
	}
	recoveryView := map[string]any{"declared": false}
	qualification := map[string]any{
		"declared": false, "status": "not_declared",
		"fixtureCount": 0, "fixturesReplayPassed": false,
	}
	assuranceStatus := "uncontracted"
	if len(outputFields) > 0 {
		assuranceStatus = "intent_only"
	}

	if wf.Recovery != nil && wf.Recovery.Contract != nil {
		contract := wf.Recovery.Contract
		effectKinds := make(map[string]struct{}, len(contract.Effects))
		for _, effect := range contract.Effects {
			effectKinds[effect.Kind] = struct{}{}
		}
		recoveryView = map[string]any{
			"declared": true, "version": contract.Version,
			"autonomyLevel":        contract.AutonomyLevel,
			"minimumEvidenceLevel": contract.Validation.MinimumEvidenceLevel,
			"semanticMode":         contract.Failure.Semantic.Mode,
			"detectorCount":        len(contract.Failure.Semantic.Detectors),
			"fixtureCount":         len(contract.Failure.Semantic.EvaluationFixtures),
			"effectCount":          len(contract.Effects), "effectKinds": sortedKeys(effectKinds),
			"productionApprovalRequired": contract.Approval.ProductionMutation == "required",
			"permission":                 contract.Approval.Permission,
		}
		assuranceStatus = "contracted"
		if contract.Version == "2" {
			outcomes := recovery.FixtureOutcomesForValidation(contract)
			passed := len(outcomes) > 0
			passFixtures, violationFixtures := 0, 0
			for _, outcome := range outcomes {
				passed = passed && outcome.Passed
				switch outcome.Expected {
				case "pass":
					passFixtures++
				case "violation":
					violationFixtures++
				}
			}
			status := "failed"
			if passed && validation.Valid {
				status = "qualified"
				assuranceStatus = "qualified"
			}
			qualification = map[string]any{
				"declared": true, "status": status,
				"detectorCount": len(contract.Failure.Semantic.Detectors),
				"fixtureCount":  len(outcomes), "passFixtureCount": passFixtures,
				"violationFixtureCount": violationFixtures,
				"fixturesReplayPassed":  passed,
			}
		}
	}
	if !validation.Valid {
		assuranceStatus = "invalid"
	}

	return map[string]any{
		"status": assuranceStatus,
		"validation": map[string]any{
			"valid": validation.Valid, "issues": validationIssueViews(validation.Issues),
		},
		"readiness": map[string]any{
			"status": readiness.Status, "issues": readinessIssueViews(readiness.Issues),
		},
		"intent": intent, "recovery": recoveryView, "qualification": qualification,
	}
}

// assureWorkflow is a tenant-scoped, read-only evidence projection. It never
// returns the persisted DAG, node configs, templates, credential references,
// fixture contents, or provider outputs.
func (d Deps) assureWorkflow(ctx context.Context, workflowID string) (*mcp.CallToolResult, any, error) {
	if workflowID == "" {
		return expected("workflowId is required")
	}
	q := store.New(d.Pool)
	workflow, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: d.OrgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("workflow not found")
		}
		return nil, nil, err
	}
	version, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
		WorkflowID: workflow.ID, OrgID: d.OrgID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("workflow has no saved version")
		}
		return nil, nil, err
	}
	wf, parseIssues := domain.Parse(version.DagJson)
	if wf == nil {
		return ok(map[string]any{
			"workflowId": workflow.ID, "name": workflow.Name,
			"versionId": version.ID, "version": version.Version,
			"status": "invalid",
			"validation": map[string]any{
				"valid": false, "issues": validationIssueViews(parseIssues),
			},
		})
	}
	validation := domain.ValidateWithSemanticFixtures(
		wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation,
	)
	payload := assuranceProjection(wf, validation)
	payload["workflowId"] = workflow.ID
	payload["name"] = workflow.Name
	payload["versionId"] = version.ID
	payload["version"] = version.Version
	return ok(payload)
}
