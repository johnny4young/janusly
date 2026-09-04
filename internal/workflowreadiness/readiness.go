// Package workflowreadiness evaluates the shared, deterministic production
// readiness model for workflow documents. It layers environment-independent
// domain checks with tenant-scoped persistence evidence so HTTP, MCP, and any
// future operator surface cannot disagree about whether a workflow is ready.
package workflowreadiness

import (
	"context"
	"fmt"
	"os"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/secretstore"
	"github.com/johnny4young/janusly/internal/store"
)

// CredentialRefCap is the strict upper bound on distinct credential names and
// MCP aliases resolved per readiness evaluation.
const CredentialRefCap = 50

// Options returns the registry-backed options shared by every readiness
// consumer. Unknown tool names remain external through the registry's
// fail-safe classification.
func Options() domain.ReadinessOptions {
	registry := executors.SharedToolRegistry()
	return domain.ReadinessOptions{
		IsWriteSideTool: func(tool string, _ map[string]any) bool {
			return registry.IsWriteSide(tool)
		},
		IsExternalTool:      registry.IsExternal,
		RequireEvalCoverage: os.Getenv("JANUSLY_REQUIRE_EVAL_COVERAGE") == "true",
	}
}

// Evaluate returns the complete readiness projection: pure workflow checks,
// rollback availability, and tenant-scoped credential/MCP reference health.
func Evaluate(
	ctx context.Context,
	db store.DBTX,
	orgID string,
	wf *domain.Workflow,
) (domain.ReadinessResult, error) {
	base := domain.CheckWorkflowReadiness(wf, Options())
	rollback, err := rollbackAvailabilityIssues(ctx, store.New(db), orgID, wf.ID)
	if err != nil {
		return domain.ReadinessResult{}, err
	}
	credentials, err := credentialReadinessIssues(ctx, store.New(db), orgID, wf)
	if err != nil {
		return domain.ReadinessResult{}, err
	}
	return merge(base, append(rollback, credentials...)), nil
}

func rollbackAvailabilityIssues(
	ctx context.Context,
	q *store.Queries,
	orgID, workflowID string,
) ([]domain.ReadinessIssue, error) {
	if workflowID == "" {
		return nil, nil
	}
	count, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		OrgID: orgID, WorkflowID: workflowID,
	})
	if err != nil {
		return nil, fmt.Errorf("count rollback workflow versions: %w", err)
	}
	if count == 0 || count >= 2 {
		return nil, nil
	}
	return []domain.ReadinessIssue{{
		Code: "workflow_missing_rollback_version", Severity: "warn",
		Message:    "Only one workflow version exists. If a future save introduces a regression there is no prior version to roll back to.",
		Suggestion: "Save the workflow at least once more (or duplicate the current version) so the runtime improvement path can roll back if confidence drops.",
	}}, nil
}

func merge(base domain.ReadinessResult, extra []domain.ReadinessIssue) domain.ReadinessResult {
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

func credentialNameFromConfig(config map[string]any) string {
	if direct, ok := config["credential"].(string); ok && direct != "" {
		return direct
	}
	if input, ok := config["input"].(map[string]any); ok {
		if nested, ok := input["credential"].(string); ok {
			return nested
		}
	}
	return ""
}

func credentialReadinessIssues(
	ctx context.Context,
	q *store.Queries,
	orgID string,
	wf *domain.Workflow,
) ([]domain.ReadinessIssue, error) {
	credentialRefs := map[string][]string{}
	aliasRefs := map[string][]string{}
	capped := func() bool { return len(credentialRefs)+len(aliasRefs) >= CredentialRefCap }
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
		return nil, nil
	}

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
		if err != nil {
			return nil, fmt.Errorf("list workflow credential readiness: %w", err)
		}
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
	if len(aliasRefs) > 0 {
		connections, err := q.ListMcpConnectionsForHealth(ctx, orgID)
		if err != nil {
			return nil, fmt.Errorf("list MCP connection readiness: %w", err)
		}
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
			refs, parseErr := mcpclient.ParseEnvRefs(connection.EnvRefs)
			if parseErr != nil {
				return nil, fmt.Errorf("parse MCP connection readiness refs: %w", parseErr)
			}
			missing, total := 0, len(refs)
			for _, ref := range refs {
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
	return issues, nil
}
