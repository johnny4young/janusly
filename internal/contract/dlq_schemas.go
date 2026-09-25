package contract

// Snapshot JSON stays extensible; identity, lifecycle and nullable projections
// are explicit so list summaries cannot masquerade as full recovery evidence.
var deadLetterStatus = map[string]any{"enum": []any{"open", "replayed", "resolved"}}

var deadLetterRecovery = closedObj(map[string]any{
	"id": str(), "owner": nullableString(), "severity": str(), "status": str(),
	"slaTargetAt": nullableString(), "resolutionReason": nullableString(), "comments": storedColumnJSON,
	"workflowId": nullableString(), "metadataWorkflowId": nullableString(),
	"occurrenceCount": map[string]any{"type": "integer", "minimum": 0}, "lastOccurredAt": nullableString(),
}, "id", "owner", "severity", "status", "slaTargetAt", "resolutionReason", "comments", "workflowId", "metadataWorkflowId", "occurrenceCount", "lastOccurredAt")

var deadLetterSummary = closedObj(map[string]any{
	"id": str(), "orgId": str(), "runId": str(), "nodeId": str(),
	"attempt": map[string]any{"type": "integer", "minimum": 0}, "status": deadLetterStatus,
	"errorJson": dlqSnapshot, "replayedAt": nullableString(), "createdAt": nullableString(),
	"nodeType": nullableString(), "workflowName": nullableString(),
	"recovery": map[string]any{"anyOf": []any{deadLetterRecovery, map[string]any{"type": "null"}}},
}, "id", "orgId", "runId", "nodeId", "attempt", "status", "errorJson", "replayedAt", "createdAt", "nodeType", "workflowName", "recovery")

var drillProvenance = closedObj(map[string]any{
	"kind":         map[string]any{"const": "solution_pack_drill"},
	"packId":       map[string]any{"type": "string", "minLength": 1, "maxLength": 128},
	"fixtureId":    map[string]any{"type": "string", "minLength": 1, "maxLength": 128},
	"recoveryPath": map[string]any{"enum": []any{"direct_failure", "runtime_failure", "stalled_node_reaper"}},
}, "kind", "packId", "fixtureId", "recoveryPath")

var drillOutcome = closedObj(map[string]any{
	"status":    map[string]any{"enum": []any{"awaiting_action", "replay_in_progress", "recovered", "accepted_loss", "measurement_incomplete"}},
	"startedAt": nullableString(), "completedAt": nullableString(),
	"elapsedMs":          map[string]any{"type": []any{"integer", "null"}, "minimum": 0},
	"evidence":           map[string]any{"enum": []any{nil, "terminal_impact", "explicit_resolution"}},
	"attemptCount":       map[string]any{"type": "integer", "minimum": 0},
	"latestDeadLetterId": str(), "chainCapped": boolT(),
	"recurrence": closedObj(map[string]any{
		"status":       map[string]any{"enum": []any{"not_applicable", "monitoring", "clear", "recurred"}},
		"windowEndsAt": nullableString(), "recurredAt": nullableString(),
	}, "status", "windowEndsAt", "recurredAt"),
}, "status", "startedAt", "completedAt", "elapsedMs", "evidence", "attemptCount", "latestDeadLetterId", "chainCapped", "recurrence")

var deadLetterDetail = closedObj(map[string]any{
	"id": str(), "orgId": str(), "runId": str(), "nodeId": str(),
	"attempt": map[string]any{"type": "integer", "minimum": 0}, "status": deadLetterStatus,
	"workflowJson": dlqSnapshot, "nodeJson": dlqSnapshot, "errorJson": dlqSnapshot,
	"replayedAt": nullableString(), "createdAt": nullableString(), "replayClaimedAt": nullableString(),
	// No suspect-version correlation is currently emitted by the detail handler.
	"suspectVersion": map[string]any{"type": "null"},
	"drill":          map[string]any{"anyOf": []any{drillProvenance, map[string]any{"type": "null"}}},
	"drillOutcome":   map[string]any{"anyOf": []any{drillOutcome, map[string]any{"type": "null"}}},
}, "id", "orgId", "runId", "nodeId", "attempt", "status", "workflowJson", "nodeJson", "errorJson", "replayedAt", "createdAt", "replayClaimedAt", "suspectVersion", "drill", "drillOutcome")
