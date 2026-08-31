// The runtime's v1 contract manifest — the analogue of the contract's
// side-effect-free V1_CONTRACT_ROUTES rule: a pure data listing of every
// /v1 route (method, path, request/response shapes) that the OpenAPI
// generator consumes WITHOUT importing the server. Adding a v1 route
// means adding one entry here; the drift guard in `make ci` regenerates
// contract/openapi.json and fails on any diff.
package contract

// Schema is a loose JSON-Schema fragment (the generator emits it as-is).
type Schema map[string]any

// Route is one v1 contract entry.
type Route struct {
	Method   string
	Path     string
	Summary  string
	Request  Schema // nil = no body
	Response Schema // the DATA payload; the v1 envelope wraps it
}

func obj(props map[string]any, required ...string) Schema {
	schema := Schema{"type": "object", "properties": props}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func str() map[string]any   { return map[string]any{"type": "string"} }
func num() map[string]any   { return map[string]any{"type": "number"} }
func boolT() map[string]any { return map[string]any{"type": "boolean"} }
func jsonValue() map[string]any {
	return map[string]any{}
}
func arr(items any) map[string]any {
	return map[string]any{"type": "array", "items": items}
}

var workflowDoc = obj(map[string]any{
	"id": str(), "name": str(), "dslVersion": str(),
	"nodes": arr(obj(map[string]any{"id": str(), "type": str(), "config": map[string]any{"type": "object"}})),
	"edges": arr(obj(map[string]any{"from": str(), "to": str()})),
}, "nodes", "edges")

var runView = obj(map[string]any{
	"run":           map[string]any{"type": "object"},
	"nodes":         arr(map[string]any{"type": "object"}),
	"events":        arr(map[string]any{"type": "object"}),
	"eventsCursor":  map[string]any{"type": []any{"string", "null"}},
	"eventsHasMore": boolT(),
})

var recoveryCase = obj(map[string]any{
	"id": str(), "orgId": str(), "runId": str(),
	"workflowId":        map[string]any{"type": []any{"string", "null"}},
	"workflowVersionId": str(), "source": str(), "detectorId": str(),
	"sourceNodeId": str(), "detectorKind": str(), "action": str(),
	"message": str(), "detailsJson": jsonValue(), "state": str(),
	"revision": num(), "createdBy": map[string]any{"type": []any{"string", "null"}},
	"createdAt": str(), "updatedAt": str(),
	"resolvedAt": map[string]any{"type": []any{"string", "null"}},
}, "id", "orgId", "runId", "workflowVersionId", "source", "detectorId",
	"sourceNodeId", "detectorKind", "action", "message", "state", "revision",
	"createdAt", "updatedAt")

var recoveryArtifact = obj(map[string]any{
	"id": str(), "caseId": str(), "kind": str(), "payload": jsonValue(),
	"sha256": str(), "actorKind": str(),
	"actorId":   map[string]any{"type": []any{"string", "null"}},
	"createdAt": str(),
}, "id", "caseId", "kind", "payload", "sha256", "actorKind", "createdAt")

var recoveryRevisionRequest = obj(map[string]any{
	"expectedRevision": map[string]any{"type": "integer", "minimum": 1},
}, "expectedRevision")

var recoveryCandidateBindingRequest = obj(map[string]any{
	"expectedRevision":    map[string]any{"type": "integer", "minimum": 1},
	"candidateArtifactId": str(),
}, "expectedRevision", "candidateArtifactId")

var recoveryApprovalBindingRequest = obj(map[string]any{
	"expectedRevision":     map[string]any{"type": "integer", "minimum": 1},
	"candidateArtifactId":  str(),
	"validationArtifactId": str(),
}, "expectedRevision", "candidateArtifactId", "validationArtifactId")

var triggerIngestResponse = obj(map[string]any{
	"ok":             boolT(),
	"duplicate":      boolT(),
	"triggerEventId": str(),
	"runId":          map[string]any{"type": []any{"string", "null"}},
}, "ok", "triggerEventId")

var workflowHealthScore = obj(map[string]any{
	"score":     map[string]any{"type": "integer"},
	"status":    str(),
	"breakdown": map[string]any{"type": "object", "additionalProperties": map[string]any{"type": "object"}},
	"signals":   map[string]any{"type": "object"},
	"slo":       map[string]any{"type": []any{"object", "null"}},
}, "score", "status", "breakdown", "signals")

var authoringCapabilities = obj(map[string]any{
	"schemaVersion": str(), "version": str(),
	"builtinTools": arr(obj(map[string]any{
		"name": str(), "description": str(), "required": arr(str()), "optional": arr(str()),
		"inputFields": arr(map[string]any{"type": "object"}), "inputExample": jsonValue(), "writeSide": boolT(),
	}, "name", "description", "required", "inputFields", "writeSide")),
	"mcpTools": arr(obj(map[string]any{
		"connectionAlias": str(), "toolName": str(), "description": str(), "writeSide": boolT(),
		"inputFields": arr(map[string]any{"type": "object"}),
	}, "connectionAlias", "toolName", "description", "writeSide", "inputFields")),
	"triggers": arr(obj(map[string]any{
		"id": str(), "nodeType": str(), "requiredConfig": arr(str()), "endpoint": str(),
	}, "id", "requiredConfig")),
	"credentials": arr(obj(map[string]any{
		"id": str(), "name": str(), "kind": str(), "configured": boolT(), "expired": boolT(),
		"expiresAt": map[string]any{"type": []any{"string", "null"}}, "updatedAt": str(),
	}, "id", "name", "kind", "configured", "expired", "updatedAt")),
	"subworkflows": arr(obj(map[string]any{
		"workflowId": str(), "name": str(), "status": str(), "latestVersion": num(),
	}, "workflowId", "name", "status", "latestVersion")),
	"primitives": arr(obj(map[string]any{
		"nodeType": str(), "requiredConfig": arr(str()), "notes": str(),
	}, "nodeType", "requiredConfig", "notes")),
	"warnings": arr(str()),
}, "schemaVersion", "version", "builtinTools", "mcpTools", "triggers", "credentials", "subworkflows", "primitives", "warnings")

var operatorBrief = obj(map[string]any{
	"version": str(), "generatedAt": str(),
	"actions": arr(obj(map[string]any{
		"id": str(), "kind": str(), "priority": map[string]any{"type": "integer"},
		"severity": str(), "titleKey": str(), "bodyKey": str(), "ctaKey": str(),
		"params": map[string]any{"type": "object"},
		"evidence": arr(obj(map[string]any{
			"kind": str(), "id": str(), "key": str(), "value": jsonValue(),
		}, "kind", "id", "key", "value")),
		"target": obj(map[string]any{
			"kind": str(), "id": str(), "runId": str(), "workflowId": str(), "destination": str(),
		}, "kind", "id", "destination"),
		"allowedActions": arr(str()), "createdAt": str(),
	}, "id", "kind", "priority", "severity", "titleKey", "bodyKey", "ctaKey", "params", "evidence", "target", "allowedActions", "createdAt")),
	"warnings": arr(str()),
}, "version", "generatedAt", "actions", "warnings")

// Routes is the closed v1 manifest, one entry per mounted /v1 route.
var Routes = []Route{
	{Method: "POST", Path: "/v1/workflows/save", Summary: "Save a workflow as a new immutable version",
		Request:  workflowDoc,
		Response: obj(map[string]any{"workflowId": str(), "versionId": str(), "version": num()})},
	{Method: "POST", Path: "/v1/workflows/rollback", Summary: "Append a prior snapshot as the new latest version",
		Request:  obj(map[string]any{"workflowId": str(), "sourceVersionId": str()}, "workflowId", "sourceVersionId"),
		Response: obj(map[string]any{"workflowId": str(), "versionId": str(), "version": num(), "sourceVersion": num()})},
	{Method: "POST", Path: "/v1/workflows/readiness", Summary: "Deterministic production-readiness check",
		Request:  obj(map[string]any{"workflow": workflowDoc}, "workflow"),
		Response: obj(map[string]any{"status": str(), "issues": arr(map[string]any{"type": "object"})}, "status", "issues")},
	{Method: "POST", Path: "/v1/validate", Summary: "Validate a workflow document without executing it",
		Request: Schema{"type": "object"},
		Response: obj(map[string]any{
			"valid": boolT(), "issues": arr(map[string]any{"type": "object"}),
		}, "valid", "issues")},
	{Method: "POST", Path: "/v1/workflows/{id}/resume", Summary: "Resume a workflow paused by its circuit breaker",
		Response: obj(map[string]any{
			"ok": boolT(), "workflowId": str(), "status": str(),
			"backfilled": num(), "failed": num(), "remaining": num(),
		}, "ok", "workflowId", "status", "backfilled", "failed", "remaining")},
	{Method: "GET", Path: "/v1/workflows", Summary: "Keyset-paginated workflow list",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "GET", Path: "/v1/workflows/latest", Summary: "Latest version of one workflow (nullable)",
		Response: Schema{"type": []any{"object", "null"}}},
	{Method: "GET", Path: "/v1/workflows/versions", Summary: "All versions of one workflow",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "GET", Path: "/v1/workflows/health", Summary: "Workflow assurance health score",
		Response: workflowHealthScore},
	{Method: "GET", Path: "/v1/templates", Summary: "Built-in workflow authoring templates",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "POST", Path: "/v1/start", Summary: "Start a run of an inline workflow document",
		Request:  obj(map[string]any{"workflow": workflowDoc, "input": map[string]any{}}, "workflow"),
		Response: obj(map[string]any{"runId": str()}, "runId")},
	{Method: "POST", Path: "/v1/webhooks/{workflowId}", Summary: "Ingest one webhook trigger event",
		Request: obj(map[string]any{
			"endpointKey": str(), "eventId": str(), "eventType": str(),
			"payload": map[string]any{"type": "object"}, "receivedAt": str(),
		}, "endpointKey", "eventId"),
		Response: triggerIngestResponse},
	{Method: "POST", Path: "/v1/triggers/email/ingest", Summary: "Ingest a normalized inbound email event",
		Request: obj(map[string]any{
			"aliasKey": str(), "from": str(), "to": str(), "subject": str(), "body": str(),
			"dkimPass": boolT(), "messageId": str(),
			"attachments":      arr(map[string]any{"type": "object"}),
			"attachmentBodies": map[string]any{"type": "object", "additionalProperties": str()},
			"receivedAt":       str(),
		}, "aliasKey", "from"),
		Response: triggerIngestResponse},
	{Method: "POST", Path: "/v1/triggers/file/ingest", Summary: "Ingest a normalized object-store event",
		Request: obj(map[string]any{
			"bucket": str(), "key": str(), "sizeBytes": num(), "contentType": str(),
			"etag": str(), "eventName": str(), "receivedAt": str(),
		}, "bucket", "key"),
		Response: triggerIngestResponse},
	{Method: "POST", Path: "/v1/triggers/mcp/ingest", Summary: "Ingest a normalized MCP resource event",
		Request: obj(map[string]any{
			"connectionAlias": str(), "resourceUri": str(), "eventType": str(),
			"payload": map[string]any{"type": "object"}, "receivedAt": str(),
		}, "connectionAlias", "resourceUri", "eventType"),
		Response: triggerIngestResponse},
	{Method: "GET", Path: "/v1/run", Summary: "One run with nodes and paginated events",
		Response: runView},
	{Method: "GET", Path: "/v1/status", Summary: "Alias of /v1/run",
		Response: runView},
	{Method: "GET", Path: "/v1/runs", Summary: "Keyset-paginated run list",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "POST", Path: "/v1/resume", Summary: "Resume one waiting node",
		Request:  obj(map[string]any{"runId": str(), "nodeId": str()}, "runId", "nodeId"),
		Response: obj(map[string]any{"resumed": boolT()}, "resumed")},
	{Method: "POST", Path: "/v1/run/cancel", Summary: "Cancel a non-terminal run",
		Request:  obj(map[string]any{"runId": str(), "reason": str()}, "runId"),
		Response: obj(map[string]any{"runId": str(), "status": str()}, "runId", "status")},
	{Method: "GET", Path: "/v1/dlq", Summary: "Dead-letter list with server-side filters",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "GET", Path: "/v1/dlq/clusters", Summary: "Failure clusters over open dead letters",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "POST", Path: "/v1/dlq/redrive", Summary: "Redrive one dead letter",
		Request:  obj(map[string]any{"deadLetterId": str()}, "deadLetterId"),
		Response: obj(map[string]any{"redriven": boolT()}, "redriven")},
	{Method: "POST", Path: "/v1/dlq/replay", Summary: "Replay one dead letter (unversioned wire)",
		Request:  obj(map[string]any{"deadLetterId": str()}, "deadLetterId"),
		Response: obj(map[string]any{"ok": boolT()}, "ok")},
	{Method: "POST", Path: "/v1/runs/redrive", Summary: "Redrive by run and node (revive-in-place)",
		Request:  obj(map[string]any{"runId": str(), "nodeId": str()}, "runId", "nodeId"),
		Response: obj(map[string]any{"ok": boolT(), "runId": str()}, "ok", "runId")},
	{Method: "POST", Path: "/v1/dlq/validate-fix", Summary: "Start a write-suppressed validation replay for a proposed fix",
		Request: obj(map[string]any{
			"deadLetterId": str(), "suggestedWorkflow": jsonValue(),
			"validationEffectMode": str(), "recoveryPlaybookId": str(),
		}, "deadLetterId", "suggestedWorkflow"),
		Response: obj(map[string]any{"runId": str()}, "runId")},
	{Method: "GET", Path: "/v1/runs/semantic-search", Summary: "Search consented run-summary memory",
		Response: obj(map[string]any{
			"enabled": boolT(), "entries": arr(map[string]any{"type": "object"}),
		}, "enabled", "entries")},
	{Method: "GET", Path: "/v1/recovery/cases", Summary: "List bounded semantic recovery cases",
		Response: obj(map[string]any{"cases": arr(recoveryCase)}, "cases")},
	{Method: "GET", Path: "/v1/recovery/cases/{caseId}", Summary: "Inspect one governed semantic recovery case",
		Response: obj(map[string]any{
			"case":        recoveryCase,
			"transitions": arr(map[string]any{"type": "object"}),
			"artifacts":   arr(recoveryArtifact),
			"autonomy":    map[string]any{"type": "object"},
		}, "case", "transitions", "artifacts", "autonomy")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/diagnose", Summary: "Record a bounded diagnosis and advance the recovery case",
		Request: recoveryRevisionRequest,
		Response: obj(map[string]any{
			"case": recoveryCase, "diagnosis": recoveryArtifact, "mode": str(),
		}, "case", "diagnosis", "mode")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/candidates", Summary: "Create immutable recovery candidates",
		Request: obj(map[string]any{
			"expectedRevision": map[string]any{"type": "integer", "minimum": 1},
			"acceptLossReason": map[string]any{"type": "string", "maxLength": 1000},
			"manualReplacement": obj(map[string]any{
				"output": jsonValue(), "reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 1000},
			}, "output", "reason"),
		}, "expectedRevision"),
		Response: obj(map[string]any{
			"case": recoveryCase, "candidates": arr(recoveryArtifact),
		}, "case", "candidates")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/validate", Summary: "Validate one immutable recovery candidate",
		Request: recoveryCandidateBindingRequest,
		Response: obj(map[string]any{
			"case": recoveryCase, "validation": recoveryArtifact, "passed": boolT(),
		}, "case", "validation", "passed")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/approve", Summary: "Create a 30-minute one-use human approval",
		Request: recoveryApprovalBindingRequest,
		Response: obj(map[string]any{
			"approval": obj(map[string]any{
				"id": str(), "caseId": str(), "caseRevision": num(),
				"candidateArtifactId": str(), "validationArtifactId": str(), "expiresAt": str(),
			}, "id", "caseId", "caseRevision", "candidateArtifactId", "validationArtifactId", "expiresAt"),
		}, "approval")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/apply", Summary: "Apply an approved immutable recovery candidate",
		Request: recoveryApprovalBindingRequest,
		Response: obj(map[string]any{
			"runId": str(), "sourceNodeId": str(), "decision": str(),
			"resumed": boolT(), "resolvedCaseIds": arr(str()),
		}, "runId", "sourceNodeId", "decision", "resumed", "resolvedCaseIds")},
	{Method: "GET", Path: "/v1/recovery/metrics", Summary: "Verified-recovery north star + cost rollup",
		Response: obj(map[string]any{
			"verifiedRecovery": map[string]any{"type": "object"},
			"mttrMs":           map[string]any{"type": []any{"number", "null"}},
			"windowDays":       num(),
			"costByProvider":   arr(map[string]any{"type": "object"}),
		})},
	{Method: "GET", Path: "/v1/recovery/ledger", Summary: "Lifetime verified-recovery impact ledger",
		Response: obj(map[string]any{"totalRecovered": num(), "downtimeEndedMs": num(), "sinceIso": map[string]any{"type": []any{"string", "null"}}})},
	{Method: "GET", Path: "/v1/recovery/my-wins", Summary: "Current operator recovery wins",
		Response: obj(map[string]any{"recovered": num(), "windowDays": num()})},
	{Method: "GET", Path: "/v1/memory/consent-status", Summary: "Tenant memory consent and purge posture",
		Response: obj(map[string]any{"enabled": boolT(), "processEnabled": boolT(), "tenantEnabled": boolT(), "purge": map[string]any{"type": "object"}})},
	{Method: "GET", Path: "/v1/run/usage", Summary: "Bounded per-run AI and memory usage",
		Response: obj(map[string]any{"loadedRows": num(), "truncated": boolT(), "rowCap": num(), "llm": map[string]any{"type": "object"}, "memory": map[string]any{"type": "object"}})},
	{Method: "GET", Path: "/v1/workflows/schedule-preview", Summary: "Validate a cron expression and preview its next fires",
		Response: obj(map[string]any{"valid": boolT(), "nextFires": arr(str())})},
	{Method: "GET", Path: "/v1/tools", Summary: "The AI Studio tool catalog",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "GET", Path: "/v1/authoring/capabilities", Summary: "Exact tenant-safe capability catalog for workflow authoring",
		Response: authoringCapabilities},
	{Method: "GET", Path: "/v1/operations/brief", Summary: "Bounded deterministic Operator Brief shared by UI and MCP",
		Response: operatorBrief},
}
