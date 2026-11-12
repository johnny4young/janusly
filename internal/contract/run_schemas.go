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
	"truncated": boolT(),
}, "nodeId", "kind", "steps", "truncated")

var runMap = closedObj(map[string]any{
	"run": closedObj(map[string]any{
		"id": str(), "status": runStatusSchema, "workflowVersionId": str(), "parentRunId": nullableString(),
	}, "id", "status", "workflowVersionId", "parentRunId"),
	"nodes":  arr(runMapNode),
	"lanes":  arr(runMapLane),
	"totals": closedObj(map[string]any{"costUsd": num(), "tokens": countT()}, "costUsd", "tokens"),
	"sessions": arr(closedObj(map[string]any{
		"id": str(), "agentClientName": str(), "runtime": str(),
	}, "id", "agentClientName", "runtime")),
}, "run", "nodes", "lanes", "totals", "sessions")

var agentSession = closedObj(map[string]any{
	"id": str(), "agentClientId": str(), "agentClientName": str(), "runtime": str(),
	"project": nullableString(), "model": nullableString(),
	"status":    strEnum([]string{"running", "idle", "ended"}),
	"truncated": boolT(), "eventCount": countT(),
	"startedAt": str(), "lastEventAt": str(), "endedAt": nullableString(),
}, "id", "agentClientId", "agentClientName", "runtime", "project", "model", "status", "truncated",
	"eventCount", "startedAt", "lastEventAt", "endedAt")

var agentSessionList = closedObj(map[string]any{
	"sessions": arr(agentSession), "nextCursor": nullableString(),
}, "sessions", "nextCursor")

var agentSessionLane = closedObj(map[string]any{
	"nodeId": str(), "kind": strEnum([]string{"external_agent", "external_subagent"}),
	"parentId": nullableString(), "agentType": nullableString(), "live": boolT(),
	"steps": arr(closedObj(map[string]any{
		"type": str(), "at": str(), "tool": str(), "status": str(), "agent": str(), "index": countT(),
	}, "type", "at", "index")),
	"truncated": boolT(),
}, "nodeId", "kind", "parentId", "agentType", "live", "steps", "truncated")

// What a draft made from the session would keep: only MCP tool calls convert.
var agentSessionConversion = closedObj(map[string]any{
	"totalSteps": countT(), "convertibleSteps": countT(), "agents": countT(),
	"mcpServers": arr(str()), "convertible": boolT(),
}, "totalSteps", "convertibleSteps", "agents", "mcpServers", "convertible")

// input is the captured tool input, present only when the client captures
// content for gated tools.
var agentSessionGate = closedObj(map[string]any{
	"id": str(), "tool": str(), "mcpServer": nullableString(), "agentId": nullableString(),
	"contentCaptured": boolT(), "input": map[string]any{}, "expiresAt": str(), "needsYou": boolT(),
}, "id", "tool", "mcpServer", "agentId", "contentCaptured", "input", "expiresAt", "needsYou")

var agentSessionMap = closedObj(map[string]any{
	"session": agentSession,
	"lanes":   arr(agentSessionLane),
	"totals": closedObj(map[string]any{
		"events": countT(), "toolCalls": countT(), "mcpCalls": countT(), "errors": countT(),
	}, "events", "toolCalls", "mcpCalls", "errors"),
	"liveSubagents": countT(),
	"refs": closedObj(map[string]any{
		"workflowIds": arr(str()), "draftIds": arr(str()), "runIds": arr(str()),
	}, "workflowIds", "draftIds", "runIds"),
	"gates":      arr(agentSessionGate),
	"conversion": agentSessionConversion,
	"canConvert": boolT(),
}, "session", "lanes", "totals", "liveSubagents", "refs", "gates", "conversion", "canConvert")

var agentSessionDraft = closedObj(map[string]any{
	"draftId": str(), "workflowId": str(), "digest": str(),
	"conversion": agentSessionConversion,
	"agents": arr(closedObj(map[string]any{
		"nodeId": str(), "agentType": str(), "tools": arr(str()), "suggestedTimeoutMs": countT(),
	}, "nodeId", "tools")),
	"mcpServers": arr(str()), "placeholders": arr(str()), "next": str(),
}, "draftId", "workflowId", "digest", "conversion", "agents", "mcpServers", "placeholders", "next")

var agentGateDecision = closedObj(map[string]any{
	"gate": closedObj(map[string]any{"id": str(), "status": strEnum([]string{"approved", "denied"})}, "id", "status"),
}, "gate")

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
	closedObj(map[string]any{
		"kind": map[string]any{"const": "agent_gate"}, "id": str(), "sessionId": str(), "tool": str(),
		"agentClientName": str(), "expiresAt": str(),
	}, "kind", "id", "sessionId", "tool", "agentClientName", "expiresAt"),
}}

var needsYou = closedObj(map[string]any{"items": arr(needsYouItem)}, "items")
