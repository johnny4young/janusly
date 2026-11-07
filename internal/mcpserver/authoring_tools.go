package mcpserver

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

// nodeGuide documents one executable step type for agents that author without
// the repository docs. Standalone examples must pass workflows.validate alone;
// the rest reference neighbours and are checked inside a small graph.
type nodeGuide struct {
	Type       string         `json:"type"`
	Required   []string       `json:"required"`
	Optional   []string       `json:"optional,omitempty"`
	Example    map[string]any `json:"example"`
	Notes      string         `json:"notes,omitempty"`
	standalone bool
}

var nodeGuides = []nodeGuide{
	{Type: "noop", Required: []string{}, Example: map[string]any{}, standalone: true},
	{Type: "transform", Required: []string{"mapping"},
		Example: map[string]any{"mapping": map[string]any{"total": "{{context.fetch.output.json.total}}"}}, standalone: true},
	{Type: "condition", Required: []string{"expression"},
		Example: map[string]any{"expression": "context.fetch.output.statusCode === 200"}, standalone: true},
	{Type: "http", Required: []string{"url"}, Optional: []string{"method", "headers", "body", "timeoutMs", "retry"},
		Example: map[string]any{"url": "https://example.com/orders/{{context.input.id}}", "method": "GET", "timeoutMs": 3000,
			"retry": map[string]any{"maxAttempts": 3}},
		Notes: "Output has statusCode, ok, body (text) and json (parsed). A non-2xx response fails the step.", standalone: true},
	{Type: "tool", Required: []string{"tool"}, Optional: []string{"input", "resultPolicy", "retry"},
		Example: map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": "{{context.input.name}}"}},
		Notes:   "Built-in tools and their inputs are in section=tools. Integration tools take a credential name in input.credential.", standalone: true},
	{Type: "loop", Required: []string{"items"}, Optional: []string{"mode", "tool", "input", "concurrency"},
		Example: map[string]any{"items": "{{context.input.items}}", "mode": "map"}, standalone: true},
	{Type: "schedule", Required: []string{"cronExpression"}, Optional: []string{"enabled"},
		Example: map[string]any{"cronExpression": "0 9 * * *"},
		Notes:   "Five-field UTC cron; connect it to the first step.", standalone: true},
	{Type: "wait_until", Required: []string{"duration|until"}, Example: map[string]any{"duration": "PT5M"},
		Notes: "ISO-8601 duration or a timezone-qualified instant.", standalone: true},
	{Type: "approval", Required: []string{}, Example: map[string]any{"message": "Approve to continue."},
		Notes: "Pauses until an authorized person resumes the run.", standalone: true},
	{Type: "human_form", Required: []string{"schema"},
		Example: map[string]any{"schema": map[string]any{"type": "object", "properties": map[string]any{
			"approved": map[string]any{"type": "boolean"}}}}, standalone: true},
	{Type: "webhook", Required: []string{}, Example: map[string]any{}, Notes: "Root step that receives the trigger payload.", standalone: true},
	{Type: "subworkflow", Required: []string{"workflowId"}, Optional: []string{"version"},
		Example: map[string]any{"workflowId": "child-workflow"}, Notes: "Exact saved workflow id from section=subworkflows.", standalone: true},
	{Type: "ai", Required: []string{"prompt|promptRef"}, Example: map[string]any{"prompt": "Summarize {{context.input.text}}"}, standalone: true},
	{Type: "agent", Required: []string{"goal"}, Optional: []string{"planner", "maxSteps", "timeoutMs"},
		Example: map[string]any{"goal": "Triage the incident"}, standalone: true},
	{Type: "multi_agent", Required: []string{"agents"},
		Example: map[string]any{"agents": []any{map[string]any{"name": "research", "goal": "Research"},
			map[string]any{"name": "review", "goal": "Review"}}}, standalone: true},
	{Type: "mcp_tool", Required: []string{"connectionAlias", "toolName"}, Optional: []string{"input", "timeoutMs"},
		Example: map[string]any{"connectionAlias": "crm", "toolName": "lookup", "input": map[string]any{}},
		Notes:   "Exposed external tools are listed in section=credentials.", standalone: true},
	{Type: "router", Required: []string{"candidates"}, Example: map[string]any{"candidates": []any{map[string]any{"nodeId": "next"}}},
		Notes: "Every candidate must be a direct successor."},
	{Type: "router_llm", Required: []string{"candidates"},
		Example: map[string]any{"candidates": []any{map[string]any{"nodeId": "next"}, map[string]any{"nodeId": "other"}}},
		Notes:   "At least two direct-successor candidates."},
	{Type: "parallel_fork", Required: []string{"branches"},
		Example: map[string]any{"branches": []any{map[string]any{"label": "a"}, map[string]any{"label": "b"}}},
		Notes:   "Pair with a join that maps each branch label to its last step."},
	{Type: "join", Required: []string{"sources"}, Example: map[string]any{"sources": map[string]any{"a": "next", "b": "other"}},
		Notes: "Maps each fork branch label to its predecessor."},
}

const workflowDocumentShape = `{"id":"optional-stable-id","name":"Name","dslVersion":"1.0","nodes":[{"id":"step","type":"noop","config":{}}],"edges":[{"from":"step","to":"next"}],"outputs":{"key":"{{context.step.output.field}}"}}`

const templateGuide = "Use {{context.input.x}} for run input and {{context.<nodeId>.output...}} for earlier steps. " +
	"Unresolved paths render empty unless templatePolicy is strict."

var issueSuggestions = map[string]string{
	domain.CodeInvalidContract:         "Match documentShape from catalog.describe section=nodes.",
	domain.CodeEmptyWorkflow:           "Add at least one step.",
	domain.CodeUnsupportedNodeType:     "Use a type from catalog.describe section=nodes.",
	domain.CodeHTTPMissingURL:          "Set config.url.",
	domain.CodeToolMissingName:         "Set config.tool to a name from catalog.describe section=tools.",
	domain.CodeToolInvalidInput:        "Match the tool's inputFields in catalog.describe section=tools.",
	domain.CodeTransformMissingMapping: "Set config.mapping to an object of output fields.",
	domain.CodeConditionMissingExpr:    "Set config.expression.",
	domain.CodeEdgeInvalidFrom:         "Point edge.from at an existing step id.",
	domain.CodeEdgeInvalidTo:           "Point edge.to at an existing step id.",
	domain.CodeScheduleInvalidCron:     "Use a five-field UTC cron such as 0 9 * * *.",
	domain.CodeCycleDetected:           "Remove the edge that closes the cycle; workflows are acyclic.",
	domain.CodeMissingStartNode:        "Leave at least one step without incoming edges.",
	domain.CodeDuplicateNodeID:         "Give every step a unique id.",
	domain.CodeNodeIDReserved:          "Rename the step; input is reserved for the run input.",
	domain.CodeRetryInvalidConfig:      "Set config.retry.maxAttempts to a positive integer.",
}

type catalogArgs struct {
	Section string `json:"section,omitempty" jsonschema:"nodes, tools, credentials, triggers or subworkflows; omit for an index"`
	Tool    string `json:"tool,omitempty" jsonschema:"with section=tools, return this tool's full input fields and example"`
}

type validateArgs struct {
	Workflow map[string]any `json:"workflow" jsonschema:"the workflow document to check; nothing is saved"`
}

func registerAuthoringTools(server *mcp.Server, deps Deps) {
	mcp.AddTool(server, readTool(
		"catalog.describe", "Describe capabilities",
		"Describe what a workflow can use: document shape, step types with examples, built-in tools, triggers, saved subworkflows, and credential names with status. Never returns secret values.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args catalogArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).describeCatalog(ctx, args.Section, args.Tool)
	})
	mcp.AddTool(server, readTool(
		"workflows.validate", "Validate workflow",
		"Check a workflow document against the gate workflows.save applies, plus readiness and tenant bindings. Returns every issue with a suggestion and saves nothing.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args validateArgs) (*mcp.CallToolResult, any, error) {
		if allowed, message := deps.at(ctx).guardTool(ctx, "workflows.validate", "workflows.read", false); !allowed {
			return expected(message)
		}
		return ok(deps.at(ctx).validationReport(ctx, args.Workflow))
	})
}

func (d Deps) describeCatalog(ctx context.Context, section, toolName string) (*mcp.CallToolResult, any, error) {
	permission := "workflows.read"
	if section == "credentials" {
		permission = "credentials.read"
	}
	if allowed, message := d.guardTool(ctx, "catalog.describe", permission, false); !allowed {
		return expected(message)
	}
	if toolName != "" && section != "tools" {
		return expected("tool is only valid with section=tools")
	}
	catalog, err := d.tenantCatalog(ctx)
	if err != nil {
		return nil, nil, err
	}
	view := map[string]any{"catalogVersion": catalog.Version}
	switch section {
	case "":
		types := make([]string, 0, len(nodeGuides))
		for _, guide := range nodeGuides {
			types = append(types, guide.Type)
		}
		view["sections"] = []string{"nodes", "tools", "credentials", "triggers", "subworkflows"}
		view["nodeTypes"] = types
		view["toolCount"] = len(catalog.BuiltinTools)
		view["credentialCount"] = len(catalog.Credentials)
	case "nodes":
		view["documentShape"] = workflowDocumentShape
		view["templates"] = templateGuide
		view["nodeTypes"] = nodeGuides
	case "tools":
		if toolName == "" {
			tools := make([]map[string]any, 0, len(catalog.BuiltinTools))
			for _, tool := range catalog.BuiltinTools {
				tools = append(tools, map[string]any{
					"name": tool.Name, "description": tool.Description,
					"required": tool.Required, "writeSide": tool.WriteSide,
				})
			}
			view["tools"] = tools
			break
		}
		for _, tool := range catalog.BuiltinTools {
			if tool.Name == toolName {
				view["tool"] = tool
			}
		}
		if view["tool"] == nil {
			return expected("unknown tool; catalog.describe section=tools lists every name")
		}
	case "credentials":
		view["credentials"] = catalog.Credentials
		view["mcpTools"] = catalog.McpTools
		view["warnings"] = catalog.Warnings
	case "triggers":
		view["triggers"] = catalog.Triggers
	case "subworkflows":
		view["subworkflows"] = catalog.Subworkflows
	default:
		return expected("section must be nodes, tools, credentials, triggers or subworkflows; omit it for the index")
	}
	return ok(view)
}

// validationReport is the dry run and the body of every save or start
// rejection, so a refused document always lists all of its issues.
func (d Deps) validationReport(ctx context.Context, document map[string]any) map[string]any {
	raw, err := json.Marshal(document)
	if err != nil || len(raw) > maxMCPWorkflowDocumentBytes {
		return map[string]any{"valid": false, "issues": []map[string]any{{
			"code": "workflow_too_large", "message": "workflow document is invalid or exceeds 128000 bytes",
			"suggestion": "Split the workflow or remove large inline values.",
		}}}
	}
	workflow, parseIssues := domain.Parse(raw)
	if workflow == nil {
		return map[string]any{"valid": false, "issues": actionableIssues(parseIssues)}
	}
	blocking := []domain.Issue{}
	for _, issue := range workflowvalidation.Validate(workflow).Issues {
		if issue.Code != domain.CodeNodeTypeNotExecutable {
			blocking = append(blocking, issue)
		}
	}
	readiness := domain.CheckWorkflowReadiness(workflow, mcpReadinessOptions())
	readinessViews := make([]map[string]any, 0, min(len(readiness.Issues), maxMCPProposalIssues))
	for _, issue := range readiness.Issues[:min(len(readiness.Issues), maxMCPProposalIssues)] {
		readinessViews = append(readinessViews, map[string]any{
			"code": issue.Code, "severity": issue.Severity, "nodeId": boundedMCPText(issue.NodeID, 160),
			"message":    boundedMCPText(issue.Message, maxMCPErrorSummaryRunes),
			"suggestion": boundedMCPText(issue.Suggestion, maxMCPErrorSummaryRunes),
		})
	}
	report := map[string]any{
		"valid": len(blocking) == 0, "issues": actionableIssues(blocking),
		"readiness": map[string]any{"status": readiness.Status, "issues": readinessViews},
	}
	// Binding alternatives name tenant credentials, which catalog.describe
	// also gates behind credentials.read.
	if d.Permissions["credentials.read"] {
		catalog, err := d.tenantCatalog(ctx)
		if err != nil {
			report["bindingsWithheld"] = "tenant bindings are temporarily unavailable"
			return report
		}
		bindings, _, _ := authoring.BindWorkflowJSON(catalog, document)
		report["bindings"] = mcpBindingReportView(bindings)
	} else {
		report["bindingsWithheld"] = "tenant bindings name credentials and require credentials.read"
	}
	return report
}

// tenantCatalog is the organization's capability catalog with subworkflows
// narrowed to a scoped client's workflows.
func (d Deps) tenantCatalog(ctx context.Context) (authoring.Catalog, error) {
	catalog := authoring.NewBuilder(d.Pool, d.CatalogSource).Build(ctx, d.OrgID)
	if !d.scoped() {
		return catalog, nil
	}
	set, err := d.scopeSet(ctx)
	if err != nil {
		return catalog, err
	}
	visible := make([]authoring.SubworkflowCapability, 0, len(catalog.Subworkflows))
	for _, entry := range catalog.Subworkflows {
		if set[entry.WorkflowID] {
			visible = append(visible, entry)
		}
	}
	catalog.Subworkflows = visible
	return catalog, nil
}

func actionableIssues(issues []domain.Issue) []map[string]any {
	out := make([]map[string]any, 0, min(len(issues), maxMCPProposalIssues))
	for _, issue := range issues[:min(len(issues), maxMCPProposalIssues)] {
		suggestion := issueSuggestions[issue.Code]
		if suggestion == "" {
			suggestion = "Compare the step with its example in catalog.describe section=nodes."
		}
		out = append(out, map[string]any{
			"code": issue.Code, "message": boundedMCPText(issue.Message, maxMCPErrorSummaryRunes),
			"nodeId": boundedMCPText(issue.NodeID, 160), "edgeId": boundedMCPText(issue.EdgeID, 160),
			"suggestion": suggestion,
		})
	}
	return out
}

// expectedReport is an isError result whose text is the JSON report, so one
// rejected call shows every issue instead of the first one and a count.
func expectedReport(message string, report map[string]any) (*mcp.CallToolResult, any, error) {
	report["error"] = message
	raw, err := json.Marshal(report)
	if err != nil || len(raw) > maxMCPResponseBytes {
		return expected(message)
	}
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}}, nil, nil
}
