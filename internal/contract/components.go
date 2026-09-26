package contract

import (
	"fmt"
	"maps"
	"reflect"
	"slices"
)

// Component is a shared fragment the OpenAPI document emits once under
// components/schemas and references by $ref wherever the manifest embeds it.
type Component struct {
	Name   string
	Schema map[string]any
}

// Components lists the named fragments. Identity is the map value itself, so a
// helper that returns a fresh map (str(), nullable(...)) is never shared.
var Components = []Component{
	// Workflow documents
	{"WorkflowDoc", workflowDoc},
	{"WorkflowNodeDoc", workflowNodeDoc},
	{"WorkflowEdgeDoc", workflowEdgeDoc},
	{"WorkflowMetadataDoc", workflowMetadataDoc},
	{"WorkflowUIDoc", workflowUIDoc},
	{"WorkflowPositionDoc", workflowPositionDoc},
	{"WorkflowNodeConfig", workflowNodeConfig},
	{"WorkflowParsedJSON", workflowParsedJSON},
	{"CanonicalWorkflowDoc", canonicalWorkflowDoc},
	{"WorkflowComparisonSnapshot", workflowComparisonSnapshot},
	{"WorkflowSaveRequest", workflowSaveDoc},
	{"WorkflowRequest", workflowRequest},
	{"WorkflowVersion", workflowVersion},
	{"WorkflowVersionSnapshot", workflowVersionSnapshot},
	{"WorkflowListItem", workflowListItem},
	{"ReadinessIssue", readinessIssue},
	{"ReadinessResult", readinessResult},
	{"ValidationIssue", validationIssue},
	{"TriggerIngestResponse", triggerIngestResponse},
	{"RelayPayload", relayPayload},
	{"HumanInput", humanInput},
	{"RunInput", runInput},
	{"ReplacementOutput", replacementOutput},

	// Runs
	{"RunStatus", runStatusSchema},
	{"RunOutcomeStatus", runOutcomeSchema},
	{"ValidationEvidenceLevel", validationEvidenceSchema},
	{"RunRecord", runRecord},
	{"RunNode", runNode},
	{"RunEvent", runEvent},
	{"RunView", runView},
	{"RunSummary", runSummary},
	{"RunJSON", runJSON},
	{"RunUsage", runUsage},

	// Dead letters
	{"DeadLetterStatus", deadLetterStatus},
	{"DeadLetterRecovery", deadLetterRecovery},
	{"DeadLetterSummary", deadLetterSummary},
	{"DeadLetterDetail", deadLetterDetail},
	{"DrillProvenance", drillProvenance},
	{"DrillOutcome", drillOutcome},
	{"DlqSnapshot", dlqSnapshot},
	{"StoredColumnJSON", storedColumnJSON},

	// Recovery
	{"RecoveryCaseState", recoveryCaseState},
	{"RecoveryActorKind", recoveryActorKind},
	{"RecoveryCase", recoveryCase},
	{"RecoveryArtifact", recoveryArtifact},
	{"RecoveryTransition", recoveryTransition},
	{"RecoveryAutonomy", recoveryAutonomy},
	{"RecoveryActiveApproval", recoveryActiveApproval},
	{"RecoveryCaseDetail", recoveryCaseDetail},
	{"RecoveryRevisionRequest", recoveryRevisionRequest},
	{"RecoveryCandidateBindingRequest", recoveryCandidateBindingRequest},
	{"RecoveryApprovalBindingRequest", recoveryApprovalBindingRequest},
	{"RecoveryEvidenceJSON", recoveryEvidenceJSON},
	{"MetricSeverity", metricSeverity},
	{"RecoveryMetric", recoveryMetric},
	{"CostProviderRow", costProviderRow},
	{"RecoveryMetrics", recoveryMetrics},
	{"FailureCluster", failureCluster},
	{"FailureClusters", failureClusters},
	{"RecallEntry", recallEntry},
	{"MemoryMetadata", memoryMetadata},
	{"RecoveryLedger", recoveryLedger},
	{"RecoveryWins", recoveryWins},
	{"MemoryConsentStatus", memoryConsentStatus},
	{"ValidationBreakdown", validationBreakdown},
	{"NullableCount", nullableCount},
	{"RecoveryValidationReport", recoveryValidationReport},
	{"RecoveryHomeQueue", recoveryHomeQueue},
	{"RecoveryHeatmap", recoveryHeatmap},
	{"RecoveryHomeCases", recoveryHomeCases},
	{"RecoveryHome", recoveryHome},

	// Health and rollout
	{"RationaleMeta", rationaleMeta},
	{"HealthEntry", healthEntry},
	{"HealthStatus", healthStatus},
	{"WorkflowHealthScore", workflowHealthScore},
	{"WorkflowHealthDelta", workflowHealthDelta},
	{"WorkflowRollout", workflowRollout},
	{"RolloutEnvelope", rolloutEnvelope},
	{"QualificationSummary", qualificationSummary},
	{"WorkflowQualification", workflowQualification},
	{"QualificationEnvelope", qualificationEnvelope},

	// Authoring and catalogs
	{"BriefLanguage", briefLanguage},
	{"WorkflowIntentBriefInput", workflowIntentBriefInput},
	{"WorkflowIntentBrief", workflowIntentBrief},
	{"WorkflowBriefCompilation", workflowBriefCompilation},
	{"WorkflowCapabilityBinding", workflowCapabilityBinding},
	{"WorkflowBindingReport", workflowBindingReport},
	{"WorkflowProposalResponse", workflowProposalResponse},
	{"AuthoringMCPInputField", authoringMCPInputField},
	{"AuthoringCapabilities", authoringCapabilities},
	{"OperatorBriefParams", operatorBriefParams},
	{"OperatorBrief", operatorBrief},
	{"ToolInputExample", toolInputExample},
	{"ToolCatalogEntry", toolCatalogEntry},
	{"TemplateCatalogEntry", templateCatalogEntry},

	// Suggestions
	{"SuggestionSafety", suggestionSafety},
	{"WorkflowSuggestion", workflowSuggestion},
	{"SuggestionEvidence", suggestionEvidence},
	{"RecoveryPassport", recoveryPassport},
	{"WorkflowPatchResponse", workflowPatchResponse},
	{"RecoveryPlaybook", recoveryPlaybook},
	{"PlaybookUseResponse", playbookUseResponse},
}

// ComponentRef is the JSON pointer a rendered document uses for a component.
func ComponentRef(name string) string { return "#/components/schemas/" + name }

func identity(schema map[string]any) uintptr { return reflect.ValueOf(schema).Pointer() }

var componentNames = func() map[uintptr]string {
	byIdentity := make(map[uintptr]string, len(Components))
	for _, component := range Components {
		byIdentity[identity(component.Schema)] = component.Name
	}
	return byIdentity
}()

// ComponentName reports the component a schema map is registered as.
func ComponentName(schema map[string]any) (string, bool) {
	name, ok := componentNames[identity(schema)]
	return name, ok
}

// RenderSchema deep-copies a manifest fragment, replacing every registered
// component, the fragment itself included, with a $ref.
func RenderSchema(value any) any {
	return renderSchema(value, false)
}

func renderSchema(value any, root bool) any {
	switch typed := value.(type) {
	case Schema:
		return renderMap(typed, root)
	case map[string]any:
		return renderMap(typed, root)
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = renderSchema(item, false)
		}
		return out
	}
	return value
}

func renderMap(schema map[string]any, root bool) map[string]any {
	if name, named := ComponentName(schema); named && !root {
		return map[string]any{"$ref": ComponentRef(name)}
	}
	out := make(map[string]any, len(schema))
	for _, key := range slices.Sorted(maps.Keys(schema)) {
		out[key] = renderSchema(schema[key], false)
	}
	return out
}

// ComponentSchemas renders every component body, keyed by name.
func ComponentSchemas() (map[string]any, error) {
	out := make(map[string]any, len(Components))
	seen := make(map[uintptr]string, len(Components))
	for _, component := range Components {
		if component.Schema == nil {
			return nil, fmt.Errorf("component %s has no schema", component.Name)
		}
		if _, duplicate := out[component.Name]; duplicate {
			return nil, fmt.Errorf("component name %s is registered twice", component.Name)
		}
		if previous, shared := seen[identity(component.Schema)]; shared {
			return nil, fmt.Errorf("components %s and %s name the same schema", previous, component.Name)
		}
		seen[identity(component.Schema)] = component.Name
		out[component.Name] = renderSchema(component.Schema, true)
	}
	return out, nil
}
