// The runtime's v1 contract manifest — the analogue of the contract's
// side-effect-free V1_CONTRACT_ROUTES rule: a pure data listing of every
// /v1 route (method, path, request/response shapes) that the OpenAPI
// generator consumes WITHOUT importing the server. Adding a v1 route
// means adding one entry here; the drift guard in `make ci` regenerates
// contract/openapi.json and fails on any diff.
package contract

import "maps"

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

func closedObj(props map[string]any, required ...string) Schema {
	schema := obj(props, required...)
	schema["additionalProperties"] = false
	return schema
}

func str() map[string]any   { return map[string]any{"type": "string"} }
func num() map[string]any   { return map[string]any{"type": "number"} }
func boolT() map[string]any { return map[string]any{"type": "boolean"} }

// strEnum declares a vocabulary whose single source is a Go list.
func strEnum(values []string) map[string]any {
	enum := make([]any, len(values))
	for i, value := range values {
		enum[i] = value
	}
	return map[string]any{"type": "string", "enum": enum}
}

func nullableStrEnum(values []string) map[string]any {
	schema := strEnum(values)
	schema["type"] = []any{"string", "null"}
	schema["enum"] = append(schema["enum"].([]any), nil)
	return schema
}

func intT() map[string]any   { return map[string]any{"type": "integer"} }
func countT() map[string]any { return map[string]any{"type": "integer", "minimum": 0} }
func nullableNum() map[string]any {
	return map[string]any{"type": []any{"number", "null"}}
}
func nullable(schema map[string]any) map[string]any {
	return map[string]any{"anyOf": []any{schema, map[string]any{"type": "null"}}}
}

func arr(items any) map[string]any {
	return map[string]any{"type": "array", "items": items}
}

func workflowSaveSchema() Schema {
	baseProperties, _ := workflowDoc["properties"].(map[string]any)
	properties := make(map[string]any, len(baseProperties)+1)
	maps.Copy(properties, baseProperties)
	properties["upstreamHealthSources"] = map[string]any{
		"type": "array", "maxItems": 50,
		"items": map[string]any{"type": "string", "minLength": 1, "maxLength": 80},
	}
	return Schema{
		"type": "object", "properties": properties,
		"required": []string{"nodes", "edges"}, "additionalProperties": false,
	}
}

var workflowSaveDoc = workflowSaveSchema()

// A purpose-built immutable authoring snapshot. The exact-version read does
// not expose tenant ids, SLO internals, or every historical DAG: callers need
// only enough information to prove and hydrate the incident's source version.
var workflowVersionSnapshot = closedObj(map[string]any{
	"id": str(), "workflowId": str(),
	"version": map[string]any{"type": "integer", "minimum": 1},
	"dagJson": workflowDoc,
}, "id", "workflowId", "version", "dagJson")

// A 2xx ingest is a started run, a deduplicated delivery, or an event buffered
// while the workflow is paused (202). Each branch has its own closed key set.
var triggerIngestResponse = map[string]any{"oneOf": []any{
	closedObj(map[string]any{
		"ok": map[string]any{"const": true}, "triggerEventId": str(), "runId": str(),
	}, "ok", "triggerEventId", "runId"),
	closedObj(map[string]any{
		"ok": map[string]any{"const": true}, "duplicate": map[string]any{"const": true},
		"triggerEventId": str(), "runId": nullableString(),
	}, "ok", "duplicate", "triggerEventId", "runId"),
	closedObj(map[string]any{
		"ok": map[string]any{"const": true}, "buffered": map[string]any{"const": true},
		"reason": str(), "triggerEventId": str(),
	}, "ok", "buffered", "reason", "triggerEventId"),
}}

// Relay payloads are the upstream system's own event body; form input is
// validated against the waiting node's own schema at resume time.
var relayPayload = map[string]any{"type": "object"}
var humanInput = map[string]any{"type": "object"}

// Routes is the closed v1 manifest, one entry per mounted /v1 route.
var Routes = []Route{
	{Method: "POST", Path: "/v1/workflows/save", Summary: "Save a workflow as a new immutable version",
		Request: workflowSaveDoc,
		Response: closedObj(map[string]any{
			"workflowId": str(), "versionId": str(), "version": map[string]any{"type": "integer", "minimum": 1},
		}, "workflowId", "versionId", "version")},
	{Method: "POST", Path: "/v1/workflows/rollback", Summary: "Append a prior snapshot as the new latest version",
		Request: closedObj(map[string]any{"workflowId": str(), "sourceVersionId": str()}, "workflowId", "sourceVersionId"),
		Response: closedObj(map[string]any{
			"workflowId": str(), "versionId": str(),
			"version":       map[string]any{"type": "integer", "minimum": 1},
			"sourceVersion": map[string]any{"type": "integer", "minimum": 1},
		}, "workflowId", "versionId", "version", "sourceVersion")},
	{Method: "POST", Path: "/v1/workflows/readiness", Summary: "Deterministic production-readiness check",
		Request:  workflowRequest,
		Response: readinessResult},
	{Method: "POST", Path: "/v1/validate", Summary: "Validate a workflow document without executing it",
		Request: workflowRequest,
		Response: closedObj(map[string]any{
			"valid": boolT(), "issues": arr(validationIssue),
		}, "valid", "issues")},
	{Method: "POST", Path: "/v1/workflows/{id}/resume", Summary: "Resume a workflow paused by its circuit breaker",
		Response: closedObj(map[string]any{
			"ok": map[string]any{"const": true}, "workflowId": str(), "status": str(),
			"backfilled": countT(), "failed": countT(), "remaining": countT(),
		}, "ok", "workflowId", "status", "backfilled", "failed", "remaining")},
	{Method: "GET", Path: "/v1/workflows", Summary: "Keyset-paginated workflow list",
		Response: boundedPage(workflowListItem)},
	{Method: "GET", Path: "/v1/workflows/latest", Summary: "Latest version of one workflow (nullable)",
		Response: Schema{"anyOf": []any{workflowVersion, Schema{"type": "null"}}}},
	{Method: "GET", Path: "/v1/workflows/versions", Summary: "Keyset-paginated versions of one workflow",
		Response: boundedPage(workflowVersion)},
	{Method: "GET", Path: "/v1/workflows/versions/{versionId}", Summary: "One exact immutable workflow version",
		Response: workflowVersionSnapshot},
	{Method: "GET", Path: "/v1/workflows/health", Summary: "Workflow assurance health score",
		Response: workflowHealthScore},
	{Method: "GET", Path: "/v1/workflows/health/delta", Summary: "Workflow health before and after a version cutoff",
		Response: workflowHealthDelta},
	{Method: "POST", Path: "/v1/workflows/{workflowId}/rollout", Summary: "Start a bounded canary rollout",
		Request: closedObj(map[string]any{
			"baselineVersionId": str(), "canaryVersionId": str(), "trafficPercent": intT(),
			"minimumSampleSize": intT(), "minimumSuccessRatePercent": intT(),
		}, "baselineVersionId", "canaryVersionId"),
		Response: rolloutEnvelope},
	{Method: "POST", Path: "/v1/workflows/{workflowId}/rollout/{rolloutId}/{decision}", Summary: "Promote or roll back an active rollout",
		Request:  closedObj(map[string]any{"reason": str()}),
		Response: rolloutEnvelope},
	{Method: "GET", Path: "/v1/workflows/{workflowId}/rollout/qualification", Summary: "Recorded recovery qualification for a version pair",
		Response: qualificationEnvelope},
	{Method: "POST", Path: "/v1/workflows/{workflowId}/rollout/qualification", Summary: "Qualify a candidate version against the baseline dataset",
		Request: closedObj(map[string]any{
			"baselineVersionId": str(), "candidateVersionId": str(),
		}, "baselineVersionId", "candidateVersionId"),
		Response: qualificationEnvelope},
	{Method: "GET", Path: "/v1/templates", Summary: "Built-in workflow authoring templates",
		Response: arr(templateCatalogEntry)},
	{Method: "POST", Path: "/v1/start", Summary: "Start an exact saved workflow version or an ad-hoc document",
		Request: closedObj(map[string]any{
			"workflow": workflowDoc, "workflowVersionId": str(), "input": runInput,
		}, "workflow"),
		Response: closedObj(map[string]any{"runId": str()}, "runId")},
	{Method: "POST", Path: "/v1/webhooks/{workflowId}", Summary: "Ingest one webhook trigger event",
		Request: closedObj(map[string]any{
			"endpointKey": str(), "eventId": str(), "eventType": str(),
			"payload": relayPayload, "receivedAt": str(),
		}, "endpointKey", "eventId"),
		Response: triggerIngestResponse},
	{Method: "POST", Path: "/v1/triggers/email/ingest", Summary: "Ingest a normalized inbound email event",
		Request: closedObj(map[string]any{
			"aliasKey": str(), "from": str(), "to": str(), "subject": str(), "body": str(),
			"dkimPass": boolT(), "messageId": str(),
			"attachments": arr(closedObj(map[string]any{
				"filename": str(), "contentType": str(), "sizeBytes": num(),
			}, "filename")),
			"attachmentBodies": map[string]any{"type": "object", "additionalProperties": str()},
			"receivedAt":       str(),
		}, "aliasKey", "from"),
		Response: triggerIngestResponse},
	{Method: "POST", Path: "/v1/triggers/file/ingest", Summary: "Ingest a normalized object-store event",
		Request: closedObj(map[string]any{
			"bucket": str(), "key": str(), "sizeBytes": num(), "contentType": str(),
			"etag": str(), "eventName": str(), "receivedAt": str(),
		}, "bucket", "key"),
		Response: triggerIngestResponse},
	{Method: "POST", Path: "/v1/triggers/mcp/ingest", Summary: "Ingest a normalized MCP resource event",
		Request: closedObj(map[string]any{
			"connectionAlias": str(), "resourceUri": str(), "eventType": str(),
			"payload": relayPayload, "receivedAt": str(),
		}, "connectionAlias", "resourceUri", "eventType"),
		Response: triggerIngestResponse},
	{Method: "GET", Path: "/v1/run", Summary: "One run with nodes and paginated events",
		Response: runView},
	{Method: "GET", Path: "/v1/status", Summary: "Alias of /v1/run",
		Response: runView},
	{Method: "GET", Path: "/v1/runs", Summary: "Keyset-paginated run list",
		Response: boundedPage(runSummary)},
	{Method: "POST", Path: "/v1/resume", Summary: "Resume one waiting node",
		Request: closedObj(map[string]any{
			"runId": str(), "nodeId": str(), "input": humanInput, "resumeToken": str(),
		}, "runId", "nodeId"),
		Response: closedObj(map[string]any{"resumed": map[string]any{"const": true}}, "resumed")},
	{Method: "POST", Path: "/v1/run/cancel", Summary: "Cancel a non-terminal run",
		Request:  closedObj(map[string]any{"runId": str(), "reason": str()}, "runId"),
		Response: closedObj(map[string]any{"runId": str(), "status": map[string]any{"const": "cancelled"}}, "runId", "status")},
	{Method: "GET", Path: "/v1/dlq", Summary: "Dead-letter list with server-side filters",
		Response: map[string]any{"type": "array", "items": deadLetterSummary, "maxItems": 200}},
	{Method: "GET", Path: "/v1/dlq/entries/{deadLetterId}", Summary: "Tenant-bound dead-letter snapshot", Response: deadLetterDetail},
	{Method: "POST", Path: "/v1/dlq/resolve", Summary: "Resolve one dead letter as accepted loss",
		Request:  closedObj(map[string]any{"id": map[string]any{"type": "string", "minLength": 1}}, "id"),
		Response: closedObj(map[string]any{"ok": map[string]any{"const": true}}, "ok")},
	{Method: "GET", Path: "/v1/dlq/clusters", Summary: "Failure clusters over open dead letters",
		Response: failureClusters},
	{Method: "POST", Path: "/v1/dlq/redrive", Summary: "Redrive one dead letter",
		Request:  closedObj(map[string]any{"deadLetterId": str()}, "deadLetterId"),
		Response: closedObj(map[string]any{"redriven": map[string]any{"const": true}}, "redriven")},
	{Method: "POST", Path: "/v1/dlq/replay", Summary: "Replay one dead letter, or one run node by exact identity",
		Request: closedObj(map[string]any{
			"deadLetterId": str(), "runId": str(), "nodeId": str(), "suggestedWorkflow": nullable(workflowDoc),
			"recoveryPlaybookId": str(), "recoveryValidationRunId": str(),
		}),
		Response: closedObj(map[string]any{"ok": map[string]any{"const": true}}, "ok")},
	{Method: "POST", Path: "/v1/runs/redrive", Summary: "Redrive by run and node (revive-in-place)",
		Request:  closedObj(map[string]any{"runId": str(), "nodeId": str()}, "runId", "nodeId"),
		Response: closedObj(map[string]any{"ok": map[string]any{"const": true}, "runId": str()}, "ok", "runId")},
	{Method: "POST", Path: "/v1/dlq/validate-fix", Summary: "Start a write-suppressed validation replay for a proposed fix",
		Request: closedObj(map[string]any{
			"deadLetterId": str(), "suggestedWorkflow": workflowDoc,
			"validationEffectMode": str(), "recoveryPlaybookId": str(),
		}, "deadLetterId", "suggestedWorkflow"),
		Response: closedObj(map[string]any{"runId": str()}, "runId")},
	{Method: "POST", Path: "/v1/ai/patch-workflow", Summary: "Suggest a validated fix for one dead letter without applying it",
		Request:  closedObj(map[string]any{"deadLetterId": str(), "model": str()}, "deadLetterId"),
		Response: workflowPatchResponse},
	{Method: "POST", Path: "/v1/recovery/playbooks/{id}/use", Summary: "Offer an active Recovery Playbook's validated source for one dead letter",
		Request:  closedObj(map[string]any{"deadLetterId": str()}, "deadLetterId"),
		Response: playbookUseResponse},
	{Method: "GET", Path: "/v1/runs/semantic-search", Summary: "Search consented run-summary memory",
		Response: closedObj(map[string]any{
			"enabled": boolT(), "entries": arr(recallEntry),
		}, "enabled", "entries")},
	{Method: "GET", Path: "/v1/recovery/home", Summary: "Coalesced Recovery Center read model",
		Response: recoveryHome},
	{Method: "GET", Path: "/v1/recovery/cases", Summary: "List bounded semantic recovery cases",
		Response: closedObj(map[string]any{"cases": arr(recoveryCase)}, "cases")},
	{Method: "GET", Path: "/v1/recovery/cases/{caseId}", Summary: "Inspect one governed semantic recovery case",
		Response: recoveryCaseDetail},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/diagnose", Summary: "Record a bounded diagnosis and advance the recovery case",
		Request: recoveryRevisionRequest,
		Response: closedObj(map[string]any{
			"case": recoveryCase, "diagnosis": recoveryArtifact,
			"mode": map[string]any{"type": "string", "enum": []any{"ai_enriched", "deterministic_fallback"}},
		}, "case", "diagnosis", "mode")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/candidates", Summary: "Create immutable recovery candidates",
		Request: closedObj(map[string]any{
			"expectedRevision": map[string]any{"type": "integer", "minimum": 1},
			"acceptLossReason": map[string]any{"type": "string", "maxLength": 1000},
			"manualReplacement": closedObj(map[string]any{
				"output": replacementOutput, "reason": map[string]any{"type": "string", "minLength": 1, "maxLength": 1000},
			}, "output", "reason"),
		}, "expectedRevision"),
		Response: closedObj(map[string]any{
			"case": recoveryCase, "candidates": arr(recoveryArtifact),
		}, "case", "candidates")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/validate", Summary: "Validate one immutable recovery candidate",
		Request: recoveryCandidateBindingRequest,
		Response: closedObj(map[string]any{
			"case": recoveryCase, "validation": recoveryArtifact, "passed": boolT(),
		}, "case", "validation", "passed")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/approve", Summary: "Create a 30-minute one-use human approval",
		Request: recoveryApprovalBindingRequest,
		Response: closedObj(map[string]any{
			"approval": closedObj(map[string]any{
				"id": str(), "caseId": str(), "caseRevision": map[string]any{"type": "integer", "minimum": 1},
				"candidateArtifactId": str(), "validationArtifactId": str(), "expiresAt": str(),
			}, "id", "caseId", "caseRevision", "candidateArtifactId", "validationArtifactId", "expiresAt"),
		}, "approval")},
	{Method: "POST", Path: "/v1/recovery/cases/{caseId}/apply", Summary: "Apply an approved immutable recovery candidate",
		Request: recoveryApprovalBindingRequest,
		Response: closedObj(map[string]any{
			"runId": str(), "sourceNodeId": str(), "decision": str(),
			"resumed": boolT(), "resolvedCaseIds": arr(str()),
		}, "runId", "sourceNodeId", "decision", "resumed", "resolvedCaseIds")},
	{Method: "GET", Path: "/v1/recovery/metrics", Summary: "Recovery metrics: verified-recovery north star, reliability rollup, cost, value estimate",
		Response: recoveryMetrics},
	{Method: "GET", Path: "/v1/recovery/ledger", Summary: "Lifetime verified-recovery impact ledger",
		Response: recoveryLedger},
	{Method: "GET", Path: "/v1/recovery/my-wins", Summary: "Current operator recovery wins",
		Response: recoveryWins},
	{Method: "GET", Path: "/v1/memory/consent-status", Summary: "Tenant memory consent and purge posture",
		Response: memoryConsentStatus},
	{Method: "GET", Path: "/v1/run/usage", Summary: "Bounded per-run AI and memory usage",
		Response: runUsage},
	{Method: "GET", Path: "/v1/workflows/schedule-preview", Summary: "Validate a cron expression and preview its next fires",
		Response: closedObj(map[string]any{"valid": boolT(), "nextFires": arr(str())}, "valid", "nextFires")},
	{Method: "GET", Path: "/v1/tools", Summary: "The AI Studio tool catalog",
		Response: arr(toolCatalogEntry)},
	{Method: "GET", Path: "/v1/authoring/capabilities", Summary: "Exact tenant-safe capability catalog for workflow authoring",
		Response: authoringCapabilities},
	{Method: "POST", Path: "/v1/ai/workflow-briefs/compile", Summary: "Compile a bounded deterministic workflow intent brief",
		Request: closedObj(map[string]any{
			"prompt": str(), "brief": workflowIntentBriefInput,
		}),
		Response: workflowBriefCompilation},
	{Method: "POST", Path: "/v1/ai/workflow-proposals", Summary: "Build a capability-bound workflow proposal without applying it",
		Request: closedObj(map[string]any{
			"prompt": str(), "brief": workflowIntentBriefInput,
			"currentWorkflow": workflowComparisonSnapshot, "catalogVersion": str(), "model": str(),
		}),
		Response: workflowProposalResponse},
	{Method: "GET", Path: "/v1/operations/brief", Summary: "Bounded deterministic Operator Brief shared by UI and MCP",
		Response: operatorBrief},
}
