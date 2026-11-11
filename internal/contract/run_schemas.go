package contract

var runStatusSchema = map[string]any{"type": "string", "enum": []any{"created", "running", "waiting", "succeeded", "failed", "cancelled", "timed_out"}}
var runOutcomeSchema = map[string]any{"enum": []any{nil, "semantic_violation", "semantic_quarantined", "semantic_recovering", "semantic_recovered", "semantic_accepted_loss"}}
var validationEvidenceSchema = map[string]any{"enum": []any{nil, "static", "writes_skipped", "provider_simulated", "live_canary"}}

// Run snapshots keep extension JSON values opaque, but not the surrounding
// identity, lifecycle, nullability or pagination contract. No new node limit is
// imposed: only the existing eventsLimit ceiling bounds an event page.
var runRecord = closedObj(map[string]any{
	"id": str(), "orgId": str(), "workflowVersionId": str(),
	"workflowRolloutId": nullableString(), "workflowRolloutVariant": nullableString(),
	"status":                 runStatusSchema,
	"outcomeStatus":          runOutcomeSchema,
	"semanticViolationCount": map[string]any{"type": "integer", "minimum": 0},
	"inputJson":              runJSON, "outputJson": runJSON,
	"parentRunId": nullableString(), "parentNodeId": nullableString(), "parentLinkKind": nullableString(),
	"parentNotificationAfter": nullableString(), "recoveryPlaybookAppliedRecordedAt": nullableString(),
	"recoveryPlaybookValidationRecordedAt": nullableString(),
	"replayMode":                           nullableString(), "traceId": nullableString(),
	"validationEvidenceLevel": validationEvidenceSchema,
	"createdBy":               nullableString(), "createdAt": nullableString(),
}, "id", "orgId", "workflowVersionId", "workflowRolloutId", "workflowRolloutVariant", "status",
	"outcomeStatus", "semanticViolationCount", "inputJson", "outputJson", "parentRunId", "parentNodeId",
	"parentLinkKind", "parentNotificationAfter", "recoveryPlaybookAppliedRecordedAt", "recoveryPlaybookValidationRecordedAt",
	"replayMode", "traceId", "validationEvidenceLevel", "createdBy", "createdAt")

func runNodeStatus() map[string]any {
	return map[string]any{"type": "string", "enum": []any{"pending", "queued", "running", "waiting", "succeeded", "failed", "skipped", "cancelled"}}
}

var runNode = closedObj(map[string]any{
	"id": str(), "runId": str(), "nodeId": str(),
	"status":    runNodeStatus(),
	"stateJson": runJSON, "errorJson": runJSON,
	"attempts":  map[string]any{"type": []any{"integer", "null"}, "minimum": 0},
	"startedAt": nullableString(), "finishedAt": nullableString(),
}, "id", "runId", "nodeId", "status", "stateJson", "errorJson", "attempts", "startedAt", "finishedAt")

var runEvent = closedObj(map[string]any{
	"id": str(), "runId": str(), "nodeId": nullableString(), "type": str(),
	"payload": runJSON, "createdAt": nullableString(), "holdUntil": nullableString(),
}, "id", "runId", "nodeId", "type", "payload", "createdAt", "holdUntil")

var runView = closedObj(map[string]any{
	"run": runRecord, "nodes": arr(runNode),
	"events":       map[string]any{"type": "array", "items": runEvent, "maxItems": 500},
	"eventsCursor": nullableString(), "eventsHasMore": boolT(),
}, "run", "nodes", "events", "eventsCursor", "eventsHasMore")

func nullableString() map[string]any { return map[string]any{"type": []any{"string", "null"}} }

var runMapNode = closedObj(map[string]any{
	"nodeId": str(), "type": str(), "status": runNodeStatus(), "attempts": countT(),
	"startedAt": nullableString(), "finishedAt": nullableString(),
	"elapsedMs": map[string]any{"type": []any{"integer", "null"}, "minimum": 0},
	"costUsd":   num(), "tokens": countT(), "stuck": boolT(), "needsYou": boolT(),
	"waitingKind": nullableString(), "childRunId": nullableString(),
}, "nodeId", "type", "status", "attempts", "startedAt", "finishedAt", "elapsedMs", "costUsd", "tokens",
	"stuck", "needsYou", "waitingKind", "childRunId")

var runMapLane = closedObj(map[string]any{
	"nodeId": str(), "kind": str(),
	"steps": arr(closedObj(map[string]any{
		"type": str(), "at": nullableString(), "tool": str(), "status": str(), "agent": str(), "name": str(),
		"iteration": countT(), "index": countT(),
	}, "type", "at")),
}, "nodeId", "kind", "steps")

var runMap = closedObj(map[string]any{
	"run": closedObj(map[string]any{
		"id": str(), "status": runStatusSchema, "workflowVersionId": str(), "parentRunId": nullableString(),
	}, "id", "status", "workflowVersionId", "parentRunId"),
	"nodes":  arr(runMapNode),
	"lanes":  arr(runMapLane),
	"totals": closedObj(map[string]any{"costUsd": num(), "tokens": countT()}, "costUsd", "tokens"),
}, "run", "nodes", "lanes", "totals")

var needsYouItem = map[string]any{"oneOf": []any{
	closedObj(map[string]any{
		"kind": map[string]any{"const": "tool_approval"}, "id": str(), "runId": str(), "nodeId": str(),
		"workflowId": str(), "tool": str(), "expiresAt": str(),
	}, "kind", "id", "runId", "nodeId", "workflowId", "tool", "expiresAt"),
	closedObj(map[string]any{
		"kind": strEnum([]string{"approval", "human_form"}), "runId": str(), "nodeId": str(),
		"workflowId": str(), "since": nullableString(),
	}, "kind", "runId", "nodeId", "workflowId", "since"),
	closedObj(map[string]any{
		"kind": map[string]any{"const": "publish_request"}, "id": str(), "workflowId": str(),
		"reasons": arr(str()), "requestedBy": str(), "expiresAt": str(),
	}, "kind", "id", "workflowId", "reasons", "requestedBy", "expiresAt"),
}}

var needsYou = closedObj(map[string]any{"items": arr(needsYouItem)}, "items")
