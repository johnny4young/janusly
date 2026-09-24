package contract

// Per-node-type configuration is validated by the node's executor, not the
// transport, so it stays an open map.
var workflowNodeConfig = map[string]any{"type": "object", "additionalProperties": jsonValue()}

// Request-side workflow documents: the domain parser strips unknown keys
// rather than rejecting them, so these objects stay open.
var workflowPositionDoc = obj(map[string]any{"x": num(), "y": num()}, "x", "y")

var workflowUIDoc = obj(map[string]any{
	"positions": map[string]any{"type": "object", "additionalProperties": workflowPositionDoc},
})

var workflowMetadataDoc = obj(map[string]any{"description": str(), "tags": arr(str())})

var workflowNodeDoc = obj(map[string]any{
	"id": str(), "type": str(), "label": str(), "config": workflowNodeConfig,
}, "id", "type", "config")

var workflowEdgeDoc = obj(map[string]any{
	"id": str(), "from": str(), "to": str(), "condition": str(), "onError": boolT(),
}, "from", "to")

var workflowDoc = obj(map[string]any{
	"id": str(), "name": str(), "dslVersion": str(), "templatePolicy": str(),
	"metadata": workflowMetadataDoc,
	"inputs":   jsonValue(),
	"outputs":  map[string]any{"type": "object", "additionalProperties": str()},
	"recovery": jsonValue(),
	"ui":       workflowUIDoc,
	"nodes":    arr(workflowNodeDoc),
	"edges":    arr(workflowEdgeDoc),
}, "nodes", "edges")

// Server-rendered workflows are the parsed domain document, so every key is
// known. Metadata is optional because suggestion routes marshal the parsed
// workflow directly rather than through the canonical save form.
var canonicalWorkflowDoc = closedObj(map[string]any{
	"id": str(), "name": str(), "dslVersion": str(), "templatePolicy": str(),
	"metadata": closedObj(map[string]any{"description": str(), "tags": arr(str())}, "tags"),
	"inputs":   jsonValue(),
	"outputs":  map[string]any{"type": "object", "additionalProperties": str()},
	"recovery": jsonValue(),
	"ui": closedObj(map[string]any{
		"positions": map[string]any{"type": "object", "additionalProperties": closedObj(map[string]any{"x": num(), "y": num()}, "x", "y")},
	}),
	"nodes": arr(closedObj(map[string]any{
		"id": str(), "type": str(), "label": str(), "config": workflowNodeConfig,
	}, "id", "type", "config")),
	"edges": arr(closedObj(map[string]any{
		"id": str(), "from": str(), "to": str(), "condition": str(), "onError": boolT(),
	}, "from", "to")),
}, "dslVersion", "nodes", "edges")

// currentWorkflow is only a comparison snapshot for proposal diffs: callers
// send their whole canvas document and the runtime reads nodes and edges.
var workflowComparisonSnapshot = obj(map[string]any{
	"nodes": arr(workflowNodeDoc),
	"edges": arr(workflowEdgeDoc),
}, "nodes", "edges")

var readinessIssue = closedObj(map[string]any{
	"code": str(), "severity": map[string]any{"type": "string", "enum": []any{"info", "warn", "fail"}},
	"message": str(), "nodeId": str(), "edgeId": str(), "suggestion": str(),
}, "code", "severity", "message")

var readinessResult = closedObj(map[string]any{
	"status": map[string]any{"type": "string", "enum": []any{"pass", "warn", "fail"}},
	"issues": arr(readinessIssue),
}, "status", "issues")

var validationIssue = closedObj(map[string]any{
	"code": str(), "message": str(), "nodeId": str(), "edgeId": str(),
}, "code", "message")

var workflowRequest = closedObj(map[string]any{"workflow": workflowDoc}, "workflow")
