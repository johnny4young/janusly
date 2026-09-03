// Structural validation ported check by check, in the contract's order,
// from the source contract Codes and messages are
// wire contract: the web matches codes for localized messages.
package domain

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/httpcontract"
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
	CodeHTTPInvalidConfig           = "http_invalid_config"
	CodeToolMissingName             = "tool_missing_name"
	CodeToolInvalidInput            = "tool_invalid_input"
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
	CodeAIMissingPrompt             = "ai_missing_prompt"
	CodeAIInvalidPromptRef          = "ai_invalid_prompt_ref"
	CodeAIInvalidPromptVariables    = "ai_invalid_prompt_variables"
	CodeAIInvalidOutputSchema       = "ai_invalid_output_schema"
	CodeAgentMissingGoal            = "agent_missing_goal"
	CodeAgentInvalidPlanner         = "agent_invalid_planner"
	CodeAgentInvalidMaxSteps        = "agent_invalid_max_steps"
	CodeAgentInvalidTimeout         = "agent_invalid_timeout"
	CodeAgentInvalidBoolean         = "agent_invalid_boolean"
	CodeAgentInvalidConfig          = "agent_invalid_config"
	CodeAgentInvalidTool            = "agent_invalid_tool"
	CodeMultiAgentMissingAgents     = "multi_agent_missing_agents"
	CodeMultiAgentInvalidAgents     = "multi_agent_invalid_agents"
	CodeMultiAgentInvalidMode       = "multi_agent_invalid_mode"
	CodeMultiAgentInvalidAgg        = "multi_agent_invalid_aggregation"
	CodeMultiAgentInvalidBoolean    = "multi_agent_invalid_boolean"
	CodeMultiAgentInvalidConfig     = "multi_agent_invalid_config"
	CodeLoopMissingItems            = "loop_missing_items"
	CodeLoopInvalidMode             = "loop_invalid_mode"
	CodeLoopForEachMissingTool      = "loop_for_each_missing_tool"
	CodeLoopForEachUnknownTool      = "loop_for_each_unknown_tool"
	CodeLoopInvalidConcurrency      = "loop_invalid_concurrency"
	CodeLoopInvalidFailureCount     = "loop_invalid_failure_count"
	CodeLoopInvalidFailurePercent   = "loop_invalid_failure_percentage"
	CodeLoopConflictingFailureLimit = "loop_conflicting_failure_budgets"
	CodeParallelForkInvalidBranches = "parallel_fork_invalid_branches"
	CodeJoinInvalidSources          = "join_invalid_sources"
	CodeTriggerInvalidConfig        = "trigger_invalid_config"
	CodeRetryInvalidConfig          = "retry_invalid_config"
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

// ToolConfigValidator validates one exact executable tool name and, when
// strictInput is true, its required authored inputs. It is injected by the
// runtime composition layer so domain does not own executable callbacks.
type ToolConfigValidator func(name string, input map[string]any, strictInput bool) error

type ValidationOptions struct {
	ToolValidator             ToolConfigValidator
	AllowIncompleteToolInputs bool
}

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
	return ValidateWithOptions(wf, validExpression, replayFixtures, ValidationOptions{})
}

// ValidateWithOptions is the fully composed workflow gate. Product surfaces
// inject the exact executable tool registry; pure domain callers still retain
// every shape check and required tool-name check without importing runtime.
func ValidateWithOptions(wf *Workflow, validExpression ExpressionValidator, replayFixtures SemanticFixtureEvaluator, options ValidationOptions) ValidationResult {
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
	// Router candidates must be direct successors. Build the adjacency once:
	// rescanning the whole edge set for each router made validation quadratic
	// for otherwise valid, body-bounded workflow documents.
	outgoingNodeIDs := map[string]map[string]bool{}
	for _, edge := range wf.Edges {
		outgoing := outgoingNodeIDs[edge.From]
		if outgoing == nil {
			outgoing = map[string]bool{}
			outgoingNodeIDs[edge.From] = outgoing
		}
		outgoing[edge.To] = true
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
		if retry, present := node.Config["retry"]; present {
			if _, err := ResolveRetryPolicy(retry); err != nil {
				push(Issue{Code: CodeRetryInvalidConfig, Message: err.Error(), NodeID: node.ID})
			}
		}
		if node.Type == "http" {
			if _, err := httpcontract.ResolveNodeConfig(node.Config, true); err != nil {
				code := CodeHTTPInvalidConfig
				if configError, ok := err.(*httpcontract.NodeConfigError); ok && configError.Kind == httpcontract.NodeConfigMissingURL {
					code = CodeHTTPMissingURL
				}
				push(Issue{Code: code, Message: err.Error(), NodeID: node.ID})
			}
		}
		if node.Type == "tool" {
			toolName, _ := node.Config["tool"].(string)
			toolName = strings.TrimSpace(toolName)
			if toolName == "" {
				push(Issue{Code: CodeToolMissingName, Message: "Tool node requires config.tool", NodeID: node.ID})
			} else if options.ToolValidator != nil {
				input := map[string]any{}
				if raw, present := node.Config["input"]; present {
					var valid bool
					input, valid = raw.(map[string]any)
					if !valid || input == nil {
						push(Issue{Code: CodeToolInvalidInput, Message: "Tool node config.input must be an object", NodeID: node.ID})
						input = nil
					}
				}
				if input != nil {
					if err := options.ToolValidator(toolName, input, !options.AllowIncompleteToolInputs); err != nil {
						push(Issue{Code: CodeToolInvalidInput, Message: err.Error(), NodeID: node.ID})
					}
				}
			}
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
				outgoing := outgoingNodeIDs[node.ID]
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
		if node.Type == "ai" {
			prompt, _ := node.Config["prompt"].(string)
			_, promptRefPresent, promptRefErr := ResolvePromptReference(node.Config, "promptRef")
			if promptRefErr != nil {
				push(Issue{Code: CodeAIInvalidPromptRef, Message: promptRefErr.Error(), NodeID: node.ID})
			}
			if _, err := ResolvePromptVariables(node.Config); err != nil {
				push(Issue{Code: CodeAIInvalidPromptVariables, Message: err.Error(), NodeID: node.ID})
			}
			if strings.TrimSpace(prompt) == "" && !promptRefPresent {
				push(Issue{Code: CodeAIMissingPrompt,
					Message: "AI node requires config.prompt or config.promptRef", NodeID: node.ID})
			}
			if schema, present := node.Config["outputSchema"]; present {
				if _, valid := ParseInputSchemaValue(schema); !valid {
					push(Issue{Code: CodeAIInvalidOutputSchema,
						Message: "AI node config.outputSchema must use the supported JSON Schema subset", NodeID: node.ID})
				}
			}
		}
		if node.Type == "agent" {
			goal, _ := node.Config["goal"].(string)
			if strings.TrimSpace(goal) == "" {
				push(Issue{Code: CodeAgentMissingGoal, Message: "Agent node requires config.goal", NodeID: node.ID})
			}
			if _, err := ResolveAgentRuntimeConfig(node.Config, AgentDefaultMaxSteps, false); err != nil {
				push(Issue{Code: agentConfigIssueCode(err, false), Message: err.Error(), NodeID: node.ID})
			} else {
				validateAgentTool(node.Config, node.ID, CodeAgentInvalidTool, options, push)
			}
		}
		if node.Type == "multi_agent" {
			resolved, err := ResolveMultiAgentRuntimeConfig(node.Config)
			if err != nil {
				push(Issue{Code: agentConfigIssueCode(err, true), Message: err.Error(), NodeID: node.ID})
			} else {
				for _, raw := range resolved.Agents {
					agent, _ := raw.(map[string]any)
					validateAgentTool(agent, node.ID, CodeMultiAgentInvalidConfig, options, push)
				}
			}
		}
		if node.Type == "loop" {
			validateLoopConfig(node, options, push)
		}
		if node.Type == "parallel_fork" {
			if _, err := ResolveParallelForkBranches(node.Config); err != nil {
				push(Issue{Code: CodeParallelForkInvalidBranches, Message: err.Error(), NodeID: node.ID})
			}
		}
		if node.Type == "join" {
			if _, err := ResolveJoinSources(node.Config); err != nil {
				push(Issue{Code: CodeJoinInvalidSources, Message: err.Error(), NodeID: node.ID})
			}
		}
		switch node.Type {
		case "webhook_received", "email_received", "file_dropped", "mcp_server_event", "pagerduty_incident":
			if err := ValidateTriggerConfig(node.Type, node.Config); err != nil {
				push(Issue{Code: CodeTriggerInvalidConfig, Message: err.Error(), NodeID: node.ID})
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

func agentConfigIssueCode(err error, multi bool) string {
	configError, ok := err.(*AgentConfigError)
	if !ok {
		if multi {
			return CodeMultiAgentInvalidConfig
		}
		return CodeAgentInvalidConfig
	}
	if multi {
		switch configError.Kind {
		case MultiAgentConfigMissingAgents:
			return CodeMultiAgentMissingAgents
		case MultiAgentConfigInvalidAgents:
			return CodeMultiAgentInvalidAgents
		case MultiAgentConfigInvalidMode:
			return CodeMultiAgentInvalidMode
		case MultiAgentConfigInvalidAgg:
			return CodeMultiAgentInvalidAgg
		case MultiAgentConfigInvalidBool:
			return CodeMultiAgentInvalidBoolean
		default:
			return CodeMultiAgentInvalidConfig
		}
	}
	switch configError.Kind {
	case AgentConfigInvalidPlanner:
		return CodeAgentInvalidPlanner
	case AgentConfigInvalidMaxSteps:
		return CodeAgentInvalidMaxSteps
	case AgentConfigInvalidTimeout:
		return CodeAgentInvalidTimeout
	case AgentConfigInvalidBoolean:
		return CodeAgentInvalidBoolean
	default:
		return CodeAgentInvalidConfig
	}
}

func validateAgentTool(config map[string]any, nodeID, issueCode string, options ValidationOptions, push func(Issue)) {
	tool, input, err := AgentConfiguredTool(config)
	if err != nil {
		push(Issue{Code: issueCode, Message: err.Error(), NodeID: nodeID})
		return
	}
	if tool == "" || options.ToolValidator == nil {
		return
	}
	if err := options.ToolValidator(tool, input, !options.AllowIncompleteToolInputs); err != nil {
		push(Issue{Code: issueCode, Message: err.Error(), NodeID: nodeID})
	}
}

func validateLoopConfig(node Node, options ValidationOptions, push func(Issue)) {
	if isJSFalsy(node.Config["items"]) {
		push(Issue{Code: CodeLoopMissingItems, Message: "Loop node requires config.items", NodeID: node.ID})
	}
	mode := "map"
	if raw, present := node.Config["mode"]; present {
		value, ok := raw.(string)
		if !ok || (value != "map" && value != "for_each") {
			push(Issue{Code: CodeLoopInvalidMode, Message: "Loop mode must be map or for_each", NodeID: node.ID})
			mode = ""
		} else {
			mode = value
		}
	}
	if mode == "for_each" {
		toolName, _ := node.Config["tool"].(string)
		toolName = strings.TrimSpace(toolName)
		if toolName == "" {
			push(Issue{Code: CodeLoopForEachMissingTool, Message: "For-each loop requires config.tool", NodeID: node.ID})
		} else if options.ToolValidator != nil {
			if err := options.ToolValidator(toolName, map[string]any{}, false); err != nil {
				push(Issue{Code: CodeLoopForEachUnknownTool, Message: "Unknown tool: " + toolName, NodeID: node.ID})
			}
		}
	}
	if raw, present := node.Config["concurrency"]; present && !boundedWholeNumber(raw, 1, 20) {
		push(Issue{Code: CodeLoopInvalidConcurrency,
			Message: "Loop concurrency must be an integer from 1 to 20", NodeID: node.ID})
	}
	_, hasCount := node.Config["toleratedFailureCount"]
	if raw, present := node.Config["toleratedFailureCount"]; present && !boundedWholeNumber(raw, 0, 1_000) {
		push(Issue{Code: CodeLoopInvalidFailureCount,
			Message: "Loop tolerated failure count must be an integer from 0 to 1000", NodeID: node.ID})
	}
	_, hasPercentage := node.Config["toleratedFailurePercentage"]
	if raw, present := node.Config["toleratedFailurePercentage"]; present {
		value, ok := validationFiniteNumber(raw)
		if !ok || value < 0 || value > 100 {
			push(Issue{Code: CodeLoopInvalidFailurePercent,
				Message: "Loop tolerated failure percentage must be from 0 to 100", NodeID: node.ID})
		}
	}
	if hasCount && hasPercentage {
		push(Issue{Code: CodeLoopConflictingFailureLimit,
			Message: "Loop failure budget must use either count or percentage, not both", NodeID: node.ID})
	}
}

func boundedWholeNumber(value any, minimum, maximum float64) bool {
	number, ok := validationFiniteNumber(value)
	return ok && math.Trunc(number) == number && number >= minimum && number <= maximum
}

func validationFiniteNumber(value any) (float64, bool) {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case float32:
		number = float64(typed)
	case int:
		number = float64(typed)
	case int32:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case uint:
		number = float64(typed)
	case uint32:
		number = float64(typed)
	case uint64:
		number = float64(typed)
	default:
		return 0, false
	}
	return number, !math.IsNaN(number) && !math.IsInf(number, 0)
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
	type frame struct {
		id   string
		next int
	}
	for _, node := range nodes {
		if state[node.ID] != unvisited {
			continue
		}
		state[node.ID] = visiting
		stack := []frame{{id: node.ID}}
		for len(stack) > 0 {
			current := &stack[len(stack)-1]
			successors := graph[current.id]
			if current.next >= len(successors) {
				state[current.id] = visited
				stack = stack[:len(stack)-1]
				continue
			}
			nextID := successors[current.next]
			current.next++
			switch state[nextID] {
			case visiting:
				return true
			case visited:
				continue
			default:
				state[nextID] = visiting
				stack = append(stack, frame{id: nextID})
			}
		}
	}
	return false
}
