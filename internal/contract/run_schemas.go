package contract

// Run snapshots keep extension JSON values opaque, but not the surrounding
// identity, lifecycle, nullability or pagination contract. No new node limit is
// imposed: only the existing eventsLimit ceiling bounds an event page.
var runRecord = closedObj(map[string]any{
	"id": str(), "orgId": str(), "workflowVersionId": str(),
	"workflowRolloutId": nullableString(), "workflowRolloutVariant": nullableString(),
	"status":                 map[string]any{"type": "string", "enum": []any{"created", "running", "waiting", "succeeded", "failed", "cancelled", "timed_out"}},
	"outcomeStatus":          map[string]any{"enum": []any{nil, "semantic_violation", "semantic_quarantined", "semantic_recovering", "semantic_recovered", "semantic_accepted_loss"}},
	"semanticViolationCount": map[string]any{"type": "integer", "minimum": 0},
	"inputJson":              jsonValue(), "outputJson": jsonValue(),
	"parentRunId": nullableString(), "parentNodeId": nullableString(), "parentLinkKind": nullableString(),
	"parentNotificationAfter": nullableString(), "recoveryPlaybookAppliedRecordedAt": nullableString(),
	"recoveryPlaybookValidationRecordedAt": nullableString(),
	"replayMode":                           nullableString(), "traceId": nullableString(),
	"validationEvidenceLevel": map[string]any{"enum": []any{nil, "static", "writes_skipped", "provider_simulated", "live_canary"}},
	"createdBy":               nullableString(), "createdAt": nullableString(),
}, "id", "orgId", "workflowVersionId", "workflowRolloutId", "workflowRolloutVariant", "status",
	"outcomeStatus", "semanticViolationCount", "inputJson", "outputJson", "parentRunId", "parentNodeId",
	"parentLinkKind", "parentNotificationAfter", "recoveryPlaybookAppliedRecordedAt", "recoveryPlaybookValidationRecordedAt",
	"replayMode", "traceId", "validationEvidenceLevel", "createdBy", "createdAt")

var runNode = closedObj(map[string]any{
	"id": str(), "runId": str(), "nodeId": str(),
	"status":    map[string]any{"type": "string", "enum": []any{"pending", "queued", "running", "waiting", "succeeded", "failed", "skipped", "cancelled"}},
	"stateJson": jsonValue(), "errorJson": jsonValue(),
	"attempts":  map[string]any{"type": []any{"integer", "null"}, "minimum": 0},
	"startedAt": nullableString(), "finishedAt": nullableString(),
}, "id", "runId", "nodeId", "status", "stateJson", "errorJson", "attempts", "startedAt", "finishedAt")

var runEvent = closedObj(map[string]any{
	"id": str(), "runId": str(), "nodeId": nullableString(), "type": str(),
	"payload": jsonValue(), "createdAt": nullableString(), "holdUntil": nullableString(),
}, "id", "runId", "nodeId", "type", "payload", "createdAt", "holdUntil")

var runView = closedObj(map[string]any{
	"run": runRecord, "nodes": arr(runNode),
	"events":       map[string]any{"type": "array", "items": runEvent, "maxItems": 500},
	"eventsCursor": nullableString(), "eventsHasMore": boolT(),
}, "run", "nodes", "events", "eventsCursor", "eventsHasMore")

func nullableString() map[string]any { return map[string]any{"type": []any{"string", "null"}} }
