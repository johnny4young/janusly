package contract

var briefLanguage = map[string]any{"type": "string", "enum": []any{"en", "es"}}

var workflowIntentBriefInput = closedObj(map[string]any{
	"version": str(), "objective": str(), "trigger": str(), "inputs": arr(str()),
	"expectedOutcome": str(), "externalEffects": arr(str()), "approvals": arr(str()),
	"failurePolicy": str(), "examples": arr(str()), "language": briefLanguage,
})

var workflowIntentBrief = closedObj(map[string]any{
	"version": str(), "objective": str(), "trigger": str(), "inputs": arr(str()),
	"expectedOutcome": str(), "externalEffects": arr(str()), "approvals": arr(str()),
	"failurePolicy": str(), "examples": arr(str()), "language": briefLanguage,
}, "version", "objective", "trigger", "inputs", "expectedOutcome", "externalEffects",
	"approvals", "failurePolicy", "examples", "language")

var workflowBriefCompilation = closedObj(map[string]any{
	"brief": workflowIntentBrief, "clarifyingQuestions": arr(str()), "complete": boolT(),
	"mode": map[string]any{"type": "string", "const": "deterministic"},
}, "brief", "clarifyingQuestions", "complete", "mode")

var workflowCapabilityBinding = closedObj(map[string]any{
	"kind": str(), "nodeId": str(), "field": str(), "requested": str(),
	"resolvedId": str(), "alternatives": arr(str()), "reason": str(),
}, "kind", "nodeId", "field", "alternatives")

var workflowBindingReport = closedObj(map[string]any{
	"catalogVersion": str(), "resolved": arr(workflowCapabilityBinding),
	"missing": arr(workflowCapabilityBinding), "complete": boolT(),
}, "catalogVersion", "resolved", "missing", "complete")

// proposal.workflow is the canonical parsed graph, except when the draft does
// not parse: the unparsed document is then returned with Apply closed, so the
// property keeps the request-side workflow shape.
var workflowProposalResponse = closedObj(map[string]any{
	"mode":            map[string]any{"type": "string", "enum": []any{"ai", "fallback", "error"}},
	"aiError":         str(),
	"providerGuarded": boolT(),
	"bonBackoff": closedObj(map[string]any{
		"from": map[string]any{"type": "integer", "minimum": 1},
		"to":   map[string]any{"type": "integer", "minimum": 1},
	}, "from", "to"),
	"brief":               workflowIntentBrief,
	"clarifyingQuestions": arr(str()),
	"bindings":            workflowBindingReport,
	"proposal": closedObj(map[string]any{
		"workflow":         workflowDoc,
		"intentContract":   map[string]any{"type": "object", "additionalProperties": str()},
		"recoveryContract": workflowParsedJSON,
		"qualification": closedObj(map[string]any{
			"intent": boolT(), "recovery": boolT(), "semantic": boolT(),
		}, "intent", "recovery", "semantic"),
		"assumptions": arr(str()),
		"risks":       arr(str()),
		"readiness":   readinessResult,
		"diff": closedObj(map[string]any{
			"nodesAdded": arr(str()), "nodesRemoved": arr(str()), "nodesChanged": arr(str()),
			"edgesBefore": countT(), "edgesAfter": countT(),
		}, "nodesAdded", "nodesRemoved", "nodesChanged", "edgesBefore", "edgesAfter"),
		"applicable": boolT(),
	}, "workflow", "intentContract", "recoveryContract", "qualification", "assumptions", "risks", "readiness", "diff", "applicable"),
}, "mode", "brief", "clarifyingQuestions", "bindings", "proposal")

var authoringMCPInputField = closedObj(map[string]any{
	"name": str(),
	"type": map[string]any{"type": "string", "enum": []any{
		"string", "number", "integer", "boolean", "object", "array", "unknown",
	}},
	"required": boolT(),
}, "name", "type", "required")

var authoringCapabilities = closedObj(map[string]any{
	"schemaVersion": str(), "version": str(),
	"builtinTools": arr(toolCatalogEntry),
	"mcpTools": arr(closedObj(map[string]any{
		"connectionAlias": str(), "toolName": str(), "description": str(), "writeSide": boolT(),
		"inputFields": arr(authoringMCPInputField),
	}, "connectionAlias", "toolName", "description", "writeSide", "inputFields")),
	"triggers": arr(closedObj(map[string]any{
		"id": str(), "nodeType": str(), "requiredConfig": arr(str()), "endpoint": str(),
	}, "id", "requiredConfig")),
	"credentials": arr(closedObj(map[string]any{
		"id": str(), "name": str(), "kind": str(), "configured": boolT(), "expired": boolT(),
		"expiresAt": str(), "updatedAt": str(),
	}, "id", "name", "kind", "configured", "expired", "updatedAt")),
	"subworkflows": arr(closedObj(map[string]any{
		"workflowId": str(), "name": str(), "status": str(), "latestVersion": intT(),
	}, "workflowId", "name", "status", "latestVersion")),
	"primitives": arr(closedObj(map[string]any{
		"nodeType": str(), "requiredConfig": arr(str()), "notes": str(),
	}, "nodeType", "requiredConfig", "notes")),
	"warnings": arr(str()),
}, "schemaVersion", "version", "builtinTools", "mcpTools", "triggers", "credentials", "subworkflows", "primitives", "warnings")

// Action params differ per action kind; each kind's keys are closed.
var operatorBriefParams = map[string]any{"oneOf": []any{
	closedObj(map[string]any{}),
	closedObj(map[string]any{"state": str(), "action": str()}, "state", "action"),
	closedObj(map[string]any{"count": countT(), "category": str()}, "count", "category"),
}}

var operatorBrief = closedObj(map[string]any{
	"version": str(), "generatedAt": str(),
	"actions": arr(closedObj(map[string]any{
		"id": str(), "kind": str(), "priority": intT(),
		"severity": str(), "titleKey": str(), "bodyKey": str(), "ctaKey": str(),
		"params": operatorBriefParams,
		"evidence": arr(closedObj(map[string]any{
			"kind": str(), "id": str(), "key": str(), "value": map[string]any{"type": []any{"string", "number"}},
		}, "kind", "id", "key", "value")),
		"target": closedObj(map[string]any{
			"kind": str(), "id": str(), "runId": str(), "workflowId": str(), "destination": str(),
		}, "kind", "id", "destination"),
		"allowedActions": arr(str()), "createdAt": str(),
	}, "id", "kind", "priority", "severity", "titleKey", "bodyKey", "ctaKey", "params", "evidence", "target", "allowedActions", "createdAt")),
	"warnings": arr(str()),
}, "version", "generatedAt", "actions", "warnings")
