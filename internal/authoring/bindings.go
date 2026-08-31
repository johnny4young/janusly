package authoring

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/tools"
)

type Binding struct {
	Kind         string   `json:"kind"`
	NodeID       string   `json:"nodeId"`
	Field        string   `json:"field"`
	Requested    string   `json:"requested,omitempty"`
	ResolvedID   string   `json:"resolvedId,omitempty"`
	Alternatives []string `json:"alternatives"`
	Reason       string   `json:"reason,omitempty"`
}

type BindingReport struct {
	CatalogVersion string    `json:"catalogVersion"`
	Resolved       []Binding `json:"resolved"`
	Missing        []Binding `json:"missing"`
	Complete       bool      `json:"complete"`
}

// BindWorkflow enforces the critical authoring postcondition: every external
// identifier in a proposed graph is an exact member of the current tenant
// catalog. Missing or malformed references are returned explicitly and the
// proposal remains unappliable; this function never rewrites an identifier.
func BindWorkflow(catalog Catalog, workflow *domain.Workflow) BindingReport {
	report := BindingReport{
		CatalogVersion: catalog.Version,
		Resolved:       []Binding{}, Missing: []Binding{}, Complete: true,
	}
	builtin := map[string]tools.CatalogEntry{}
	for _, entry := range catalog.BuiltinTools {
		builtin[entry.Name] = entry
	}
	mcp := map[string]mcpclient.ExposedMcpTool{}
	for _, entry := range catalog.McpTools {
		if entry.ConnectionAlias == "_truncated" || entry.ToolName == "_truncated" {
			continue
		}
		mcp[entry.ConnectionAlias+"\x00"+entry.ToolName] = entry
	}
	workflows := map[string]SubworkflowCapability{}
	for _, entry := range catalog.Subworkflows {
		workflows[entry.WorkflowID] = entry
	}
	credentials := map[string]CredentialCapability{}
	for _, entry := range catalog.Credentials {
		credentials[entry.Name] = entry
	}

	addResolved := func(binding Binding) { report.Resolved = append(report.Resolved, binding) }
	addMissing := func(binding Binding) {
		report.Missing = append(report.Missing, binding)
		report.Complete = false
	}
	for _, node := range workflow.Nodes {
		if !domain.ExecutableNodeTypes[node.Type] {
			addMissing(Binding{Kind: "node_type", NodeID: node.ID, Field: "type", Requested: node.Type, Reason: "node_type_not_executable"})
			continue
		}
		switch node.Type {
		case "tool":
			name := trimmedString(node.Config["tool"])
			entry, exists := builtin[name]
			if name == "" || !exists {
				addMissing(Binding{Kind: "builtin_tool", NodeID: node.ID, Field: "config.tool", Requested: name, Alternatives: sortedBuiltinNames(catalog), Reason: "exact_tool_not_found"})
				continue
			}
			addResolved(Binding{Kind: "builtin_tool", NodeID: node.ID, Field: "config.tool", Requested: name, ResolvedID: name, Alternatives: []string{}})
			input, _ := node.Config["input"].(map[string]any)
			for _, field := range entry.Required {
				if field == "credential" {
					continue
				}
				if !configuredInputField(input, field) {
					addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.input." + field, Reason: "tool_input_required"})
				}
			}
			if slices.Contains(entry.Required, "credential") {
				credential := trimmedString(input["credential"])
				entry, exists := credentials[credential]
				if credential == "" || !exists || !entry.Configured || entry.Expired {
					addMissing(Binding{Kind: "credential", NodeID: node.ID, Field: "config.input.credential", Requested: credential, Alternatives: availableCredentialNames(catalog, credentialKindForTool(name)), Reason: "credential_unavailable"})
				} else {
					addResolved(Binding{Kind: "credential", NodeID: node.ID, Field: "config.input.credential", Requested: credential, ResolvedID: entry.ID, Alternatives: []string{}})
				}
			}
		case "mcp_tool":
			alias := trimmedString(node.Config["connectionAlias"])
			name := trimmedString(node.Config["toolName"])
			entry, exists := mcp[alias+"\x00"+name]
			if alias == "" || name == "" || !exists {
				addMissing(Binding{Kind: "mcp_tool", NodeID: node.ID, Field: "config.connectionAlias+toolName", Requested: alias + "/" + name, Alternatives: sortedMcpNames(catalog), Reason: "exact_mcp_tool_not_found"})
			} else {
				addResolved(Binding{Kind: "mcp_tool", NodeID: node.ID, Field: "config.connectionAlias+toolName", Requested: alias + "/" + name, ResolvedID: alias + "/" + name, Alternatives: []string{}})
				input, _ := node.Config["input"].(map[string]any)
				for _, field := range entry.InputFields {
					if field.Required && !configuredInputField(input, field.Name) {
						addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.input." + field.Name, Reason: "mcp_input_required"})
					}
				}
			}
		case "subworkflow":
			workflowID := trimmedString(node.Config["workflowId"])
			entry, exists := workflows[workflowID]
			if workflowID == "" || !exists || entry.Status != "active" || workflowID == workflow.ID {
				addMissing(Binding{Kind: "subworkflow", NodeID: node.ID, Field: "config.workflowId", Requested: workflowID, Alternatives: availableSubworkflowIDs(catalog, workflow.ID), Reason: "exact_subworkflow_not_eligible"})
			} else if version, present := integerValue(node.Config["version"]); present && (version < 1 || version > int64(entry.LatestVersion)) {
				addMissing(Binding{Kind: "subworkflow", NodeID: node.ID, Field: "config.version", Requested: fmt.Sprint(version), Alternatives: []string{fmt.Sprint(entry.LatestVersion)}, Reason: "subworkflow_version_not_found"})
			} else {
				addResolved(Binding{Kind: "subworkflow", NodeID: node.ID, Field: "config.workflowId", Requested: workflowID, ResolvedID: workflowID, Alternatives: []string{}})
			}
		case "wait_until":
			if !completeWaitUntil(node.Config) {
				addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.duration|until", Alternatives: []string{"duration", "until"}, Reason: "wait_until_configuration_incomplete"})
			}
		case "schedule":
			if _, err := domain.ResolveScheduleConfig(node.Config); err != nil {
				addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.cronExpression", Requested: trimmedString(node.Config["cronExpression"]), Reason: "schedule_configuration_invalid"})
			}
		case "multi_agent":
			if !completeMultiAgent(node.Config) {
				addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.agents", Reason: "multi_agent_configuration_incomplete"})
			}
		case "router_llm":
			if !completeRouter(node, workflow) {
				addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.candidates", Reason: "router_configuration_incomplete"})
			}
		case "webhook_received":
			requireConfig(&report, node, "endpointKey")
		case "email_received":
			requireConfig(&report, node, "aliasKey")
		case "file_dropped":
			requireConfig(&report, node, "bucket")
		case "mcp_server_event":
			requireConfig(&report, node, "connectionAlias")
			requireConfig(&report, node, "resourceUri")
		}
	}
	return report
}

func BindWorkflowJSON(catalog Catalog, document map[string]any) (BindingReport, *domain.Workflow, []domain.Issue) {
	raw, err := json.Marshal(document)
	if err != nil {
		return BindingReport{CatalogVersion: catalog.Version, Resolved: []Binding{}, Missing: []Binding{{Kind: "workflow", Field: "workflow", Reason: "workflow_not_serializable"}}, Complete: false}, nil, nil
	}
	workflow, parseIssues := domain.Parse(raw)
	if workflow == nil {
		return BindingReport{CatalogVersion: catalog.Version, Resolved: []Binding{}, Missing: []Binding{{Kind: "workflow", Field: "workflow", Reason: "workflow_contract_invalid"}}, Complete: false}, nil, parseIssues
	}
	return BindWorkflow(catalog, workflow), workflow, parseIssues
}

func requireConfig(report *BindingReport, node domain.Node, field string) {
	value := trimmedString(node.Config[field])
	if value == "" {
		report.Missing = append(report.Missing, Binding{Kind: "trigger", NodeID: node.ID, Field: "config." + field, Reason: "trigger_configuration_incomplete", Alternatives: []string{}})
		report.Complete = false
	}
}

func completeWaitUntil(config map[string]any) bool {
	duration := trimmedString(config["duration"])
	until := trimmedString(config["until"])
	if (duration == "") == (until == "") {
		return false
	}
	if until != "" {
		_, err := time.Parse(time.RFC3339, until)
		return err == nil
	}
	return strings.HasPrefix(duration, "P") && duration != "P" && duration != "PT"
}

func completeMultiAgent(config map[string]any) bool {
	agents, ok := config["agents"].([]any)
	if !ok || len(agents) == 0 || len(agents) > 12 {
		return false
	}
	for _, raw := range agents {
		agent, ok := raw.(map[string]any)
		if !ok || trimmedString(agent["goal"]) == "" {
			return false
		}
	}
	return true
}

func completeRouter(node domain.Node, workflow *domain.Workflow) bool {
	candidates, ok := node.Config["candidates"].([]any)
	if !ok || len(candidates) < 2 || len(candidates) > 20 {
		return false
	}
	successors := map[string]bool{}
	for _, edge := range workflow.Edges {
		if edge.From == node.ID {
			successors[edge.To] = true
		}
	}
	for _, raw := range candidates {
		candidate, ok := raw.(map[string]any)
		if !ok {
			return false
		}
		id := trimmedString(candidate["nodeId"])
		if id == "" {
			id = trimmedString(candidate["id"])
		}
		if id == "" || !successors[id] {
			return false
		}
	}
	return true
}

func sortedBuiltinNames(catalog Catalog) []string {
	out := make([]string, 0, len(catalog.BuiltinTools))
	for _, entry := range catalog.BuiltinTools {
		out = append(out, entry.Name)
	}
	slices.Sort(out)
	return boundedAlternatives(out)
}

func sortedMcpNames(catalog Catalog) []string {
	var out []string
	for _, entry := range catalog.McpTools {
		if entry.ConnectionAlias != "_truncated" && entry.ToolName != "_truncated" {
			out = append(out, entry.ConnectionAlias+"/"+entry.ToolName)
		}
	}
	slices.Sort(out)
	return boundedAlternatives(out)
}

func availableCredentialNames(catalog Catalog, kind string) []string {
	var exact, any []string
	for _, entry := range catalog.Credentials {
		if !entry.Configured || entry.Expired {
			continue
		}
		any = append(any, entry.Name)
		if kind != "" && entry.Kind == kind {
			exact = append(exact, entry.Name)
		}
	}
	if len(exact) > 0 {
		any = exact
	}
	slices.Sort(any)
	return boundedAlternatives(any)
}

func availableSubworkflowIDs(catalog Catalog, currentID string) []string {
	var out []string
	for _, entry := range catalog.Subworkflows {
		if entry.Status == "active" && entry.WorkflowID != currentID {
			out = append(out, entry.WorkflowID)
		}
	}
	slices.Sort(out)
	return boundedAlternatives(out)
}

func boundedAlternatives(values []string) []string {
	if len(values) > 8 {
		return slices.Clone(values[:8])
	}
	return slices.Clone(values)
}

func credentialKindForTool(name string) string {
	switch {
	case name == "slack.post":
		return "slack_webhook"
	case name == "github.create_issue":
		return "github_token"
	case name == "webhook.send":
		return "webhook_secret"
	case strings.HasPrefix(name, "db."):
		return "postgres"
	case strings.HasPrefix(name, "pagerduty."):
		return "pagerduty_api_token"
	default:
		return ""
	}
}

func trimmedString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func configuredInputField(input map[string]any, field string) bool {
	value, exists := input[field]
	if !exists || value == nil {
		return false
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) != ""
	}
	return true
}

func integerValue(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		integer := int64(typed)
		return integer, float64(integer) == typed
	case int:
		return int64(typed), true
	case int32:
		return int64(typed), true
	case int64:
		return typed, true
	default:
		return 0, false
	}
}
