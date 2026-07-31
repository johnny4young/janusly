// Structural validation ported check by check, in the reference's order,
// from packages/engine/src/workflow-validation.ts. Codes and messages are
// wire contract: the web matches codes for localized messages.
package domain

import (
	"fmt"
	"regexp"
	"strings"
)

// Issue codes emitted by Parse and Validate. Closed set; additions must
// exist in the reference first (except the explicit pilot-only code).
const (
	CodeInvalidContract          = "invalid_contract"
	CodeEmptyWorkflow            = "empty_workflow"
	CodeDuplicateNodeID          = "duplicate_node_id"
	CodeNodeIDReserved           = "node_id_reserved"
	CodeUnsupportedNodeType      = "unsupported_node_type"
	CodeHTTPMissingURL           = "http_missing_url"
	CodeConditionMissingExpr     = "condition_missing_expression"
	CodeConditionInvalidExpr     = "condition_invalid_expression"
	CodeTransformMissingMapping  = "transform_missing_mapping"
	CodeEdgeInvalidFrom          = "edge_invalid_from"
	CodeEdgeInvalidTo            = "edge_invalid_to"
	CodeEdgeInvalidCondition     = "edge_invalid_condition"
	CodeEdgeConditionInputsScope = "edge_condition_inputs_scope"
	CodeInputDefaultTypeMismatch = "input_default_type_mismatch"
	CodeCycleDetected            = "cycle_detected"
	CodeMissingStartNode         = "missing_start_node"
	// Pilot-only: the type is valid in the full platform but this backend
	// does not execute it yet. Deliberately distinct from
	// unsupported_node_type, which means the type is invalid everywhere.
	CodeNodeTypeUnsupportedPilot = "node_type_unsupported_pilot"
)

// Issue mirrors the reference's validation issue shape on the wire.
type Issue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	NodeID  string `json:"nodeId,omitempty"`
	EdgeID  string `json:"edgeId,omitempty"`
}

// ValidationResult mirrors { valid, issues }.
type ValidationResult struct {
	Valid  bool    `json:"valid"`
	Issues []Issue `json:"issues"`
}

// ExpressionValidator validates the edge/condition expression grammar. The
// real grammar plugs in through this seam; until then the permissive
// validator accepts everything non-empty, and tests inject strict fakes.
type ExpressionValidator func(expression string) (valid bool, message string)

// PermissiveExpressions accepts any expression. Placeholder wiring only.
func PermissiveExpressions(string) (bool, string) { return true, "" }

// platformNodeTypes is the full platform's closed set: a type outside it is
// invalid everywhere, not merely unimplemented here.
var platformNodeTypes = map[string]bool{
	"http": true, "condition": true, "tool": true, "agent": true,
	"multi_agent": true, "agent_reflection": true, "loop": true,
	"router": true, "router_llm": true, "transform": true, "ai": true,
	"webhook": true, "approval": true, "human_form": true, "noop": true,
	"subworkflow": true, "wait_until": true, "parallel_fork": true,
	"join": true, "schedule": true, "mcp_tool": true,
	"webhook_received": true, "email_received": true, "file_dropped": true,
	"mcp_server_event": true, "pagerduty_incident": true,
}

// PilotNodeTypes is the executable subset of this backend today.
var PilotNodeTypes = map[string]bool{
	"noop": true, "transform": true, "condition": true, "http": true,
	"wait_until": true, "approval": true,
}

// inputsScopePattern flags inputs.* references on edge conditions after
// quoted string literals are stripped, mirroring the reference's guard.
var (
	quotedLiteralPattern = regexp.MustCompile(`'[^']*'|"[^"]*"`)
	inputsScopePattern   = regexp.MustCompile(`\binputs(\.|\[)`)
)

// Validate runs the ported structural checks over an already-parsed
// workflow. Parse-level problems never reach here: Parse returns its
// invalid_contract issues instead of a workflow.
func Validate(wf *Workflow, validExpression ExpressionValidator) ValidationResult {
	if validExpression == nil {
		validExpression = PermissiveExpressions
	}
	var issues []Issue
	push := func(issue Issue) { issues = append(issues, issue) }

	if len(wf.Nodes) == 0 {
		push(Issue{Code: CodeEmptyWorkflow, Message: "Workflow must include at least one node"})
	}

	nodeIDs := map[string]bool{}
	for _, node := range wf.Nodes {
		if nodeIDs[node.ID] {
			push(Issue{Code: CodeDuplicateNodeID, Message: "Duplicate node id: " + node.ID, NodeID: node.ID})
		}
		nodeIDs[node.ID] = true

		if node.ID == "input" {
			push(Issue{Code: CodeNodeIDReserved, Message: `Node id "input" is reserved for the run input (context.input)`, NodeID: node.ID})
		}
		if !platformNodeTypes[node.Type] {
			push(Issue{Code: CodeUnsupportedNodeType, Message: "Unsupported node type: " + node.Type, NodeID: node.ID})
		} else if !PilotNodeTypes[node.Type] {
			push(Issue{Code: CodeNodeTypeUnsupportedPilot, Message: fmt.Sprintf("Node type %q is not executable by this backend yet", node.Type), NodeID: node.ID})
		}
		if node.Type == "http" && isJSFalsy(node.Config["url"]) {
			push(Issue{Code: CodeHTTPMissingURL, Message: "HTTP node requires config.url", NodeID: node.ID})
		}
		if node.Type == "condition" {
			if isJSFalsy(node.Config["expression"]) {
				push(Issue{Code: CodeConditionMissingExpr, Message: "Condition node requires config.expression", NodeID: node.ID})
			} else if ok, msg := validExpression(jsString(node.Config["expression"])); !ok {
				if msg == "" {
					msg = "Invalid condition expression"
				}
				push(Issue{Code: CodeConditionInvalidExpr, Message: msg, NodeID: node.ID})
			}
		}
		if node.Type == "transform" && !isNonEmptyObject(node.Config["mapping"]) {
			push(Issue{Code: CodeTransformMissingMapping, Message: "Transform node requires a non-empty config.mapping object", NodeID: node.ID})
		}
	}

	for index, edge := range wf.Edges {
		edgeID := edge.ID
		if edgeID == "" {
			edgeID = fmt.Sprintf("edge_%d", index)
		}
		if !nodeIDs[edge.From] {
			push(Issue{Code: CodeEdgeInvalidFrom, Message: "Edge source does not exist: " + edge.From, EdgeID: edgeID})
		}
		if !nodeIDs[edge.To] {
			push(Issue{Code: CodeEdgeInvalidTo, Message: "Edge target does not exist: " + edge.To, EdgeID: edgeID})
		}
		if edge.Condition != "" {
			if ok, msg := validExpression(edge.Condition); !ok {
				if msg == "" {
					msg = "Invalid edge condition"
				}
				push(Issue{Code: CodeEdgeInvalidCondition, Message: msg, EdgeID: edgeID})
			}
			stripped := quotedLiteralPattern.ReplaceAllString(edge.Condition, "")
			if inputsScopePattern.MatchString(stripped) {
				push(Issue{
					Code:    CodeEdgeConditionInputsScope,
					Message: "Edge conditions cannot reference inputs.* (node config does not exist on an edge) — use context.input.* for the run input or context.<nodeId>.output.* for a step's output",
					EdgeID:  edgeID,
				})
			}
		}
	}

	if wf.Inputs != nil {
		for _, bad := range invalidInputDefaults(wf.Inputs, "$") {
			push(Issue{Code: CodeInputDefaultTypeMismatch, Message: fmt.Sprintf("Declared default for %s %s", bad.Path, bad.Problem)})
		}
	}

	if hasCycle(wf.Nodes, wf.Edges) {
		push(Issue{Code: CodeCycleDetected, Message: "Workflow graph contains a cycle"})
	}

	incoming := map[string]bool{}
	for _, edge := range wf.Edges {
		incoming[edge.To] = true
	}
	hasStart := false
	for _, node := range wf.Nodes {
		if !incoming[node.ID] {
			hasStart = true
			break
		}
	}
	if len(wf.Nodes) > 0 && !hasStart {
		push(Issue{Code: CodeMissingStartNode, Message: "Workflow must have at least one start node"})
	}

	return ValidationResult{Valid: len(issues) == 0, Issues: issues}
}

// isJSFalsy mirrors the reference's truthiness checks on config fields:
// absent, null, empty string, false and zero all read as missing.
func isJSFalsy(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case string:
		return v == ""
	case bool:
		return !v
	case float64:
		return v == 0
	}
	return false
}

// jsString mirrors JavaScript's String() coercion for the values a JSON
// config can carry.
func jsString(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

func isNonEmptyObject(value any) bool {
	obj, ok := value.(map[string]any)
	return ok && len(obj) > 0
}

func hasCycle(nodes []Node, edges []Edge) bool {
	graph := map[string][]string{}
	for _, node := range nodes {
		graph[node.ID] = nil
	}
	for _, edge := range edges {
		if _, ok := graph[edge.From]; ok {
			graph[edge.From] = append(graph[edge.From], edge.To)
		}
	}
	const (
		unvisited = 0
		visiting  = 1
		visited   = 2
	)
	state := map[string]int{}
	var visit func(id string) bool
	visit = func(id string) bool {
		switch state[id] {
		case visiting:
			return true
		case visited:
			return false
		}
		state[id] = visiting
		for _, next := range graph[id] {
			if visit(next) {
				return true
			}
		}
		state[id] = visited
		return false
	}
	for _, node := range nodes {
		if visit(node.ID) {
			return true
		}
	}
	return false
}
