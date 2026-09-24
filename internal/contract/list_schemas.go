package contract

var runSummary = closedObj(map[string]any{
	"id": str(), "orgId": str(), "workflowId": str(), "workflowName": nullableString(),
	"workflowVersionId": str(), "status": runStatusSchema,
	"hasWaitingNodes": boolT(), "outcomeStatus": runOutcomeSchema,
	"semanticViolationCount": map[string]any{"type": "integer", "minimum": 0}, "outputJson": runJSON,
	"parentRunId": nullableString(), "parentNodeId": nullableString(), "replayMode": nullableString(), "traceId": nullableString(),
	"validationEvidenceLevel": validationEvidenceSchema,
	"createdBy":               nullableString(), "createdAt": nullableString(),
}, "id", "orgId", "workflowId", "workflowName", "workflowVersionId", "status", "hasWaitingNodes", "outcomeStatus", "semanticViolationCount", "outputJson", "parentRunId", "parentNodeId", "replayMode", "traceId", "validationEvidenceLevel", "createdBy", "createdAt")

var workflowListItem = closedObj(map[string]any{
	"id": str(), "orgId": str(), "name": str(), "createdBy": nullableString(), "createdAt": nullableString(),
	"lastRunStatus": nullableString(), "runCount": map[string]any{"type": "integer", "minimum": 0},
	"bufferedTriggerCount": map[string]any{"type": "integer", "minimum": 0}, "status": str(),
	"pausedReason": nullableString(), "tags": arr(str()), "folder": nullableString(), "deletedAt": nullableString(),
}, "id", "orgId", "name", "createdBy", "createdAt", "lastRunStatus", "runCount", "bufferedTriggerCount", "status", "pausedReason", "tags", "folder", "deletedAt")

var workflowVersion = closedObj(map[string]any{
	"id": str(), "orgId": str(), "workflowId": str(), "version": map[string]any{"type": "integer", "minimum": 1},
	"dagJson": workflowDoc, "sloJson": storedColumnJSON, "upstreamHealthSources": storedColumnJSON,
	"createdBy": nullableString(), "createdAt": nullableString(),
}, "id", "orgId", "workflowId", "version", "dagJson", "sloJson", "upstreamHealthSources", "createdBy", "createdAt")

// An example of the tool's own input object; the tool validates it.
var toolInputExample = map[string]any{"type": "object"}

var toolCatalogEntry = closedObj(map[string]any{
	"name": str(), "description": str(), "required": arr(str()), "optional": arr(str()),
	"writeSide": boolT(), "inputExample": toolInputExample,
	"inputFields": arr(closedObj(map[string]any{
		"name": str(), "kind": map[string]any{"enum": []any{"string", "number", "integer", "boolean", "json", "array", "object", "unknown"}}, "required": boolT(),
	}, "name", "kind", "required")),
}, "name", "description", "required", "writeSide", "inputFields")

var templateCatalogEntry = closedObj(map[string]any{
	"id": str(), "name": str(), "description": str(), "category": str(),
	"nameCode": str(), "descriptionCode": str(), "categoryCode": str(),
	"requiredCredentials": arr(str()), "workflow": workflowDoc,
}, "id", "name", "description", "category", "nameCode", "descriptionCode", "categoryCode", "workflow")

func boundedPage(item Schema) Schema { return Schema{"type": "array", "items": item, "maxItems": 200} }
