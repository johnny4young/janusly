// Structural validation ported check by check, in the contract's order,
// from the source contract Codes and messages are
// wire contract: the web matches codes for localized messages.
package domain

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Issue codes emitted by Parse and Validate. Closed set; additions must
// exist in the contract first (except the explicit runtime-only code).
const (
	CodeInvalidContract             = "invalid_contract"
	CodeEmptyWorkflow               = "empty_workflow"
	CodeDuplicateNodeID             = "duplicate_node_id"
	CodeNodeIDReserved              = "node_id_reserved"
	CodeUnsupportedNodeType         = "unsupported_node_type"
	CodeHTTPMissingURL              = "http_missing_url"
	CodeConditionMissingExpr        = "condition_missing_expression"
	CodeConditionInvalidExpr        = "condition_invalid_expression"
	CodeTransformMissingMapping     = "transform_missing_mapping"
	CodeEdgeInvalidFrom             = "edge_invalid_from"
	CodeEdgeInvalidTo               = "edge_invalid_to"
	CodeEdgeInvalidCondition        = "edge_invalid_condition"
	CodeEdgeConditionInputsScope    = "edge_condition_inputs_scope"
	CodeEdgeOnErrorCondition        = "edge_on_error_condition"
	CodeInputDefaultTypeMismatch    = "input_default_type_mismatch"
	CodeScheduleInvalidCron         = "schedule_invalid_cron"
	CodeHumanFormInvalidSchema      = "human_form_invalid_schema"
	CodeHumanFormEmptySchema        = "human_form_empty_schema"
	CodeHumanFormInvalidInitial     = "human_form_invalid_initial_values"
	CodeSubworkflowMissingWorkflow  = "subworkflow_missing_workflow"
	CodeSubworkflowSelfReference    = "subworkflow_self_reference"
	CodeSubworkflowInvalidVersion   = "subworkflow_invalid_version"
	CodeRouterCandidateUnknown      = "router_candidate_unknown"
	CodeRouterCandidateNotSuccessor = "router_candidate_not_successor"
	CodeRouterMissingCandidates     = "router_missing_candidates"
	CodeRouterInvalidCandidate      = "router_invalid_candidate"
	CodeRouterCandidateMissingID    = "router_candidate_missing_node_id"
	CodeRouterCandidateUnknownID    = "router_candidate_unknown_node_id"
	CodeCycleDetected               = "cycle_detected"
	CodeMissingStartNode            = "missing_start_node"
	// Runtime-only: the type is valid in the full platform but this backend
	// does not execute it yet. Deliberately distinct from
	// unsupported_node_type, which means the type is invalid everywhere.
	CodeNodeTypeNotExecutable = "node_type_not_executable"
)

// Issue mirrors the contract's validation issue shape on the wire.
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

// ExecutableNodeTypes is the executable subset of this backend today.
var ExecutableNodeTypes = map[string]bool{
	"noop": true, "transform": true, "condition": true, "http": true,
	"wait_until": true, "webhook": true, "approval": true, "human_form": true, "tool": true,
	"parallel_fork": true, "join": true, "loop": true, "webhook_received": true,
	"router": true, "router_llm": true,
	"ai": true, "agent": true, "multi_agent": true, "mcp_tool": true,
	"pagerduty_incident": true, "email_received": true, "file_dropped": true,
	"mcp_server_event": true, "subworkflow": true, "schedule": true,
}

// inputsScopePattern flags inputs.* references on edge conditions after
// quoted string literals are stripped, mirroring the contract's guard.
var (
	quotedLiteralPattern = regexp.MustCompile(`'[^']*'|"[^"]*"`)
	inputsScopePattern   = regexp.MustCompile(`\binputs(\.|\[)`)
)

// Validate runs the ported structural checks over an already-parsed
// workflow. Parse-level problems never reach here: Parse returns its
// invalid_contract issues instead of a workflow.
func Validate(wf *Workflow, validExpression ExpressionValidator) ValidationResult {
	return ValidateWithSemanticFixtures(wf, validExpression, nil)
}

// ValidateWithSemanticFixtures is Validate plus the bounded-fixture
// qualification that needs the runtime evaluator (injected so domain
// stays grammar-free; every product surface passes the real evaluator
// from internal/recovery, mirroring the contract's single validator).
func ValidateWithSemanticFixtures(wf *Workflow, validExpression ExpressionValidator, replayFixtures SemanticFixtureEvaluator) ValidationResult {
	if validExpression == nil {
		validExpression = PermissiveExpressions
	}
	var issues []Issue
	push := func(issue Issue) { issues = append(issues, issue) }
	validateSemanticContractDAG(wf, validExpression, replayFixtures, push)

	if len(wf.Nodes) == 0 {
		push(Issue{Code: CodeEmptyWorkflow, Message: "Workflow must include at least one node"})
	}

	allNodeIDs := map[string]bool{}
	for _, node := range wf.Nodes {
		allNodeIDs[node.ID] = true
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
		} else if !ExecutableNodeTypes[node.Type] {
			push(Issue{Code: CodeNodeTypeNotExecutable, Message: fmt.Sprintf("Node type %q is not executable by this backend yet", node.Type), NodeID: node.ID})
		}
		if node.Type == "http" && isJSFalsy(node.Config["url"]) {
			push(Issue{Code: CodeHTTPMissingURL, Message: "HTTP node requires config.url", NodeID: node.ID})
		}
		if node.Type == "subworkflow" {
			workflowID, _ := node.Config["workflowId"].(string)
			workflowID = strings.TrimSpace(workflowID)
			if workflowID == "" {
				push(Issue{Code: CodeSubworkflowMissingWorkflow, Message: "Subworkflow node requires config.workflowId", NodeID: node.ID})
			} else if wf.ID != "" && workflowID == wf.ID {
				push(Issue{Code: CodeSubworkflowSelfReference, Message: "A workflow cannot call itself directly", NodeID: node.ID})
			}
			if version, present := node.Config["version"]; present && !validWorkflowVersion(version) {
				push(Issue{
					Code:    CodeSubworkflowInvalidVersion,
					Message: "Subworkflow config.version must be an integer between 1 and 2147483647",
					NodeID:  node.ID,
				})
			}
		}
		if node.Type == "router" || node.Type == "router_llm" {
			entries, isArray := arrayValues(node.Config["candidates"])
			if isArray {
				outgoing := map[string]bool{}
				for _, edge := range wf.Edges {
					if edge.From == node.ID {
						outgoing[edge.To] = true
					}
				}
				for _, candidate := range entries {
					entry, ok := candidate.(map[string]any)
					if !ok || entry == nil {
						continue
					}
					candidateID := trimmedString(entry["nodeId"])
					if candidateID == "" {
						candidateID = trimmedString(entry["id"])
					}
					if candidateID == "" {
						continue
					}
					if !allNodeIDs[candidateID] {
						push(Issue{Code: CodeRouterCandidateUnknown, Message: "Router candidate does not exist: " + candidateID, NodeID: node.ID})
					} else if !outgoing[candidateID] {
						push(Issue{
							Code:    CodeRouterCandidateNotSuccessor,
							Message: fmt.Sprintf("Router candidate %q must be a direct successor (add an edge %s → %s) or the decision cannot route", candidateID, node.ID, candidateID),
							NodeID:  node.ID,
						})
					}
				}
			}

			if !isArray || len(entries) == 0 {
				push(Issue{Code: CodeRouterMissingCandidates, Message: fmt.Sprintf("%s node requires a non-empty config.candidates array", node.Type), NodeID: node.ID})
			} else {
				for index, candidate := range entries {
					entry, ok := candidate.(map[string]any)
					if !ok || entry == nil {
						push(Issue{Code: CodeRouterInvalidCandidate, Message: fmt.Sprintf("%s candidate at index %d must be an object", node.Type, index), NodeID: node.ID})
						continue
					}
					candidateID := trimmedString(entry["nodeId"])
					if candidateID == "" {
						candidateID = trimmedString(entry["id"])
					}
					if candidateID == "" {
						push(Issue{Code: CodeRouterCandidateMissingID, Message: fmt.Sprintf("%s candidate at index %d must have a non-empty nodeId (legacy \"id\" also accepted)", node.Type, index), NodeID: node.ID})
						continue
					}
					if !allNodeIDs[candidateID] {
						push(Issue{Code: CodeRouterCandidateUnknownID, Message: fmt.Sprintf("%s candidate at index %d references an unknown node: %s", node.Type, index, candidateID), NodeID: node.ID})
					}
				}
			}
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
		if node.Type == "schedule" {
			if _, err := ResolveScheduleConfig(node.Config); err != nil {
				push(Issue{Code: CodeScheduleInvalidCron, Message: err.Error(), NodeID: node.ID})
			}
		}
		if node.Type == "human_form" {
			schema, valid := ParseInputSchemaValue(node.Config["schema"])
			if !valid {
				push(Issue{Code: CodeHumanFormInvalidSchema, Message: "Human form node requires a valid config.schema", NodeID: node.ID})
			} else if schema.Type == "object" && len(schema.Properties) == 0 {
				push(Issue{Code: CodeHumanFormEmptySchema, Message: "Human form node requires at least one field in config.schema.properties", NodeID: node.ID})
			} else if initialValues, present := node.Config["initialValues"]; present {
				if errs := ValidateInputValue(schema, initialValues, "$"); len(errs) > 0 {
					push(Issue{Code: CodeHumanFormInvalidInitial,
						Message: "Human form config.initialValues does not satisfy config.schema: " + strings.Join(errs, "; "), NodeID: node.ID})
				}
			}
		}
		if node.Type == "approval" {
			if _, err := ResolveApprovalWaitingConfig(node.Config, time.Now()); err != nil {
				code := "approval_invalid_deadline"
				if configErr, ok := err.(*WaitingConfigError); ok {
					code = configErr.Code
				}
				push(Issue{Code: code, Message: err.Error(), NodeID: node.ID})
			}
		}
		if node.Type == "wait_until" {
			if err := ValidateWaitUntilConfig(node.Config); err != nil {
				code := "wait_until_invalid_duration"
				if configErr, ok := err.(*WaitingConfigError); ok {
					code = configErr.Code
				}
				push(Issue{Code: code, Message: err.Error(), NodeID: node.ID})
			}
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
		if edge.OnError && edge.Condition != "" {
			push(Issue{
				Code:    CodeEdgeOnErrorCondition,
				Message: "An on-error edge cannot also carry a condition — it already fires only when the source node fails",
				EdgeID:  edgeID,
			})
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

const workflowVersionMax = int64(2_147_483_647)

func validWorkflowVersion(value any) bool {
	switch version := value.(type) {
	case float64:
		return version >= 1 && version <= float64(workflowVersionMax) && math.Trunc(version) == version
	case float32:
		asFloat64 := float64(version)
		return asFloat64 >= 1 && asFloat64 <= float64(workflowVersionMax) && math.Trunc(asFloat64) == asFloat64
	case int:
		return version >= 1 && int64(version) <= workflowVersionMax
	case int32:
		return version >= 1 && int64(version) <= workflowVersionMax
	case int64:
		return version >= 1 && version <= workflowVersionMax
	case uint:
		return version >= 1 && uint64(version) <= uint64(workflowVersionMax)
	case uint32:
		return version >= 1 && uint64(version) <= uint64(workflowVersionMax)
	case uint64:
		return version >= 1 && version <= uint64(workflowVersionMax)
	default:
		return false
	}
}

// isJSFalsy mirrors the contract's truthiness checks on config fields:
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
		if slices.ContainsFunc(graph[id], visit) {
			return true
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
