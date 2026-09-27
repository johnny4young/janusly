package contract

import (
	"maps"

	"github.com/johnny4young/janusly/internal/aievidence"
)

var suggestionSafety = closedObj(map[string]any{
	"writeSide": boolT(), "approvalRequired": boolT(), "approvalPresent": boolT(),
}, "writeSide", "approvalRequired", "approvalPresent")

var workflowSuggestion = closedObj(map[string]any{
	"workflow": canonicalWorkflowDoc, "rationale": str(), "approachLabel": str(),
	"confidence": num(), "calibratedConfidence": num(), "safety": suggestionSafety,
	"consideredAlternatives": arr(closedObj(map[string]any{
		"approach": str(), "rejectedBecause": str(),
	}, "approach", "rejectedBecause")),
}, "workflow", "rationale", "approachLabel", "confidence", "calibratedConfidence", "safety", "consideredAlternatives")

var suggestionEvidence = closedObj(map[string]any{
	"kind": strEnum(aievidence.KindList), "sourceRef": str(), "snippet": str(), "label": str(), "weight": num(),
}, "kind", "sourceRef", "snippet")

// No prior same-signature outcome is correlated yet; the key is always null.
var recoveryPassport = closedObj(map[string]any{
	"failureSignature": str(), "priorSameSignatureOutcome": map[string]any{"type": "null"},
}, "failureSignature", "priorSameSignatureOutcome")

func suggestionEnvelope(mode map[string]any, extra map[string]any, required ...string) Schema {
	properties := map[string]any{
		"mode": mode, "suggestedWorkflow": canonicalWorkflowDoc, "rationale": str(),
		"suggestions": arr(workflowSuggestion), "evidence": arr(suggestionEvidence),
		"recoveryPassport": recoveryPassport,
	}
	maps.Copy(properties, extra)
	return closedObj(properties, append([]string{
		"mode", "suggestedWorkflow", "rationale", "suggestions", "evidence", "recoveryPassport",
	}, required...)...)
}

// model and provider are present once a provider answered; aiError only on
// a provider-backed fallback.
var workflowPatchResponse = suggestionEnvelope(
	map[string]any{"type": "string", "enum": []any{"ai", "fallback"}},
	map[string]any{"model": str(), "provider": str(), "aiError": str()},
)

var recoveryPlaybook = closedObj(map[string]any{
	"id": str(), "workflowId": nullableString(), "signature": str(), "version": intT(),
	"status": str(), "title": str(), "instructionsMarkdown": str(), "approachLabel": str(),
	"successfulUses": countT(), "regressions": countT(),
	"lastValidatedAt": nullableString(), "activatedAt": nullableString(), "retiredAt": nullableString(),
	"createdAt": nullableString(), "updatedAt": nullableString(),
}, "id", "workflowId", "signature", "version", "status", "title", "instructionsMarkdown",
	"approachLabel", "successfulUses", "regressions", "lastValidatedAt", "activatedAt",
	"retiredAt", "createdAt", "updatedAt")

var playbookUseResponse = closedObj(map[string]any{
	"suggestion": suggestionEnvelope(map[string]any{"const": "playbook"},
		map[string]any{"playbook": recoveryPlaybook}, "playbook"),
}, "suggestion")
