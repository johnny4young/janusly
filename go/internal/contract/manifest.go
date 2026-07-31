// The pilot's v1 contract manifest — the analogue of the reference's
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
		Response: obj(map[string]any{"ready": boolT(), "issues": arr(map[string]any{"type": "object"})})},
	{Method: "GET", Path: "/v1/workflows", Summary: "Keyset-paginated workflow list",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "GET", Path: "/v1/workflows/latest", Summary: "Latest version of one workflow (nullable)",
		Response: Schema{"type": []any{"object", "null"}}},
	{Method: "GET", Path: "/v1/workflows/versions", Summary: "All versions of one workflow",
		Response: arr(map[string]any{"type": "object"})},
	{Method: "POST", Path: "/v1/start", Summary: "Start a run of an inline workflow document",
		Request:  obj(map[string]any{"workflow": workflowDoc, "input": map[string]any{}}, "workflow"),
		Response: obj(map[string]any{"runId": str()}, "runId")},
	{Method: "POST", Path: "/v1/webhooks/{workflowId}", Summary: "Ingest one webhook trigger event",
		Request: obj(map[string]any{
			"endpointKey": str(), "eventId": str(), "eventType": str(),
			"payload": map[string]any{"type": "object"}, "receivedAt": str(),
		}, "endpointKey", "eventId"),
		Response: obj(map[string]any{"ok": boolT(), "triggerEventId": str(), "runId": str()})},
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
	{Method: "POST", Path: "/v1/dlq/replay", Summary: "Replay one dead letter (reference wire)",
		Request:  obj(map[string]any{"deadLetterId": str()}, "deadLetterId"),
		Response: obj(map[string]any{"ok": boolT()}, "ok")},
	{Method: "POST", Path: "/v1/runs/redrive", Summary: "Redrive by run and node (revive-in-place)",
		Request:  obj(map[string]any{"runId": str(), "nodeId": str()}, "runId", "nodeId"),
		Response: obj(map[string]any{"ok": boolT(), "runId": str()}, "ok", "runId")},
	{Method: "GET", Path: "/v1/recovery/metrics", Summary: "Verified-recovery north star + cost rollup",
		Response: obj(map[string]any{
			"verifiedRecovery": map[string]any{"type": "object"},
			"mttrMs":           map[string]any{"type": []any{"number", "null"}},
			"windowDays":       num(),
			"costByProvider":   arr(map[string]any{"type": "object"}),
		})},
	{Method: "GET", Path: "/v1/tools", Summary: "The AI Studio tool catalog",
		Response: arr(map[string]any{"type": "object"})},
}
