package authoring

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

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
	if workflow == nil {
		report.Missing = append(report.Missing, Binding{
			Kind: "workflow", Field: "workflow", Alternatives: []string{}, Reason: "workflow_contract_invalid",
		})
		report.Complete = false
		return report
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

	addResolved := func(binding Binding) {
		report.Resolved = append(report.Resolved, bindingForWire(binding))
	}
	addMissing := func(binding Binding) {
		report.Missing = append(report.Missing, bindingForWire(binding))
		report.Complete = false
	}
	bindBuiltin := func(nodeID, fieldPrefix, name string, input map[string]any) (tools.CatalogEntry, bool) {
		toolField := fieldPrefix + ".tool"
		inputPrefix := fieldPrefix + ".input."
		entry, exists := builtin[name]
		if name == "" {
			addMissing(Binding{Kind: "builtin_tool", NodeID: nodeID, Field: toolField, Alternatives: sortedBuiltinNames(catalog), Reason: "tool_binding_required"})
			return tools.CatalogEntry{}, false
		}
		if !exists {
			addMissing(Binding{Kind: "builtin_tool", NodeID: nodeID, Field: toolField, Requested: name, Alternatives: sortedBuiltinNames(catalog), Reason: "exact_tool_not_found"})
			return tools.CatalogEntry{}, false
		}
		addResolved(Binding{Kind: "builtin_tool", NodeID: nodeID, Field: toolField, Requested: name, ResolvedID: name, Alternatives: []string{}})
		for _, field := range entry.Required {
			if field == "credential" {
				continue
			}
			if !configuredInputField(input, field) {
				addMissing(Binding{Kind: "configuration", NodeID: nodeID, Field: inputPrefix + field, Reason: "tool_input_required"})
			}
		}
		if slices.Contains(entry.Required, "credential") {
			credential := trimmedString(input["credential"])
			credentialEntry, credentialExists := credentials[credential]
			expectedKind := credentialKindForTool(name)
			reason := ""
			switch {
			case credential == "":
				reason = "credential_binding_required"
			case !credentialExists:
				reason = "exact_credential_not_found"
			case expectedKind != "" && credentialEntry.Kind != expectedKind:
				reason = "credential_kind_mismatch"
			case !credentialEntry.Configured:
				reason = "credential_not_configured"
			case credentialEntry.Expired:
				reason = "credential_expired"
			}
			credentialField := inputPrefix + "credential"
			if reason == "" {
				addResolved(Binding{Kind: "credential", NodeID: nodeID, Field: credentialField, Requested: credential, ResolvedID: credentialEntry.ID, Alternatives: []string{}})
			} else {
				addMissing(Binding{Kind: "credential", NodeID: nodeID, Field: credentialField, Requested: credential, Alternatives: availableCredentialNames(catalog, expectedKind), Reason: reason})
			}
		}
		return entry, true
	}
	bindAgentTool := func(nodeID, fieldPrefix string, config map[string]any) bool {
		name, input, err := domain.AgentConfiguredTool(config)
		if err != nil {
			addMissing(Binding{Kind: "configuration", NodeID: nodeID, Field: fieldPrefix + ".tool", Reason: "agent_tool_configuration_invalid"})
			return false
		}
		if name == "" {
			return false
		}
		entry, resolved := bindBuiltin(nodeID, fieldPrefix, name, input)
		return resolved && agentToolWriteSide(entry, name, input)
	}
	for _, node := range workflow.Nodes {
		if !domain.ExecutableNodeTypes[node.Type] {
			addMissing(Binding{Kind: "node_type", NodeID: node.ID, Field: "type", Requested: node.Type, Reason: "node_type_not_executable"})
			continue
		}
		switch node.Type {
		case "tool":
			name := trimmedString(node.Config["tool"])
			input, _ := node.Config["input"].(map[string]any)
			bindBuiltin(node.ID, "config", name, input)
		case "mcp_tool":
			alias := trimmedString(node.Config["connectionAlias"])
			name := trimmedString(node.Config["toolName"])
			entry, exists := mcp[alias+"\x00"+name]
			if alias == "" || name == "" {
				addMissing(Binding{Kind: "mcp_tool", NodeID: node.ID, Field: "config.connectionAlias+toolName", Requested: mcpIdentifier(alias, name), Alternatives: sortedMcpNames(catalog), Reason: "mcp_binding_required"})
			} else if !exists {
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
			if workflowID == "" {
				addMissing(Binding{Kind: "subworkflow", NodeID: node.ID, Field: "config.workflowId", Alternatives: availableSubworkflowIDs(catalog, workflow.ID), Reason: "subworkflow_binding_required"})
			} else if !exists || entry.Status != "active" || workflowID == workflow.ID {
				addMissing(Binding{Kind: "subworkflow", NodeID: node.ID, Field: "config.workflowId", Requested: workflowID, Alternatives: availableSubworkflowIDs(catalog, workflow.ID), Reason: "exact_subworkflow_not_eligible"})
			} else {
				if rawVersion, specified := node.Config["version"]; specified {
					version, valid := integerValue(rawVersion)
					if !valid {
						addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.version", Requested: fmt.Sprint(rawVersion), Alternatives: []string{fmt.Sprint(entry.LatestVersion)}, Reason: "subworkflow_version_invalid"})
						continue
					}
					if version < 1 || version > int64(entry.LatestVersion) {
						addMissing(Binding{Kind: "subworkflow", NodeID: node.ID, Field: "config.version", Requested: fmt.Sprint(version), Alternatives: []string{fmt.Sprint(entry.LatestVersion)}, Reason: "subworkflow_version_not_found"})
						continue
					}
				}
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
		case "loop":
			if trimmedString(node.Config["mode"]) == "for_each" {
				input, _ := node.Config["input"].(map[string]any)
				bindBuiltin(node.ID, "config", trimmedString(node.Config["tool"]), input)
			}
		case "agent":
			needsWriteOptIn := bindAgentTool(node.ID, "config", node.Config)
			allowWrites, _ := node.Config["allowWriteTools"].(bool)
			if needsWriteOptIn && !allowWrites {
				addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.allowWriteTools", Reason: "agent_write_opt_in_required"})
			}
		case "multi_agent":
			resolved, err := domain.ResolveMultiAgentRuntimeConfig(node.Config)
			if err != nil {
				addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.agents", Reason: "multi_agent_configuration_incomplete"})
				break
			}
			needsWriteOptIn := false
			for index, raw := range resolved.Agents {
				agent, _ := raw.(map[string]any)
				fieldPrefix := fmt.Sprintf("config.agents[%d]", index)
				needsWriteOptIn = bindAgentTool(node.ID, fieldPrefix, agent) || needsWriteOptIn
			}
			allowWrites, _ := node.Config["allowWriteTools"].(bool)
			if needsWriteOptIn && !allowWrites {
				addMissing(Binding{Kind: "configuration", NodeID: node.ID, Field: "config.allowWriteTools", Reason: "agent_write_opt_in_required"})
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
		case "pagerduty_incident":
			credential := trimmedString(node.Config["webhookCredential"])
			entry, exists := credentials[credential]
			reason := ""
			switch {
			case credential == "":
				reason = "credential_binding_required"
			case !exists:
				reason = "exact_credential_not_found"
			case entry.Kind != "pagerduty_webhook_secret":
				reason = "credential_kind_mismatch"
			case !entry.Configured:
				reason = "credential_not_configured"
			case entry.Expired:
				reason = "credential_expired"
			}
			if reason == "" {
				addResolved(Binding{Kind: "credential", NodeID: node.ID, Field: "config.webhookCredential", Requested: credential, ResolvedID: entry.ID, Alternatives: []string{}})
			} else {
				addMissing(Binding{Kind: "credential", NodeID: node.ID, Field: "config.webhookCredential", Requested: credential, Alternatives: availableCredentialNames(catalog, "pagerduty_webhook_secret"), Reason: reason})
			}
		}
	}
	return report
}

// HasUnboundCapabilityIdentity distinguishes provider-authored executable
// identities that are absent from the exact tenant catalog from ordinary
// incomplete configuration. The former must never survive the AI proposal
// boundary; the latter can remain visible in an unappliable draft so an
// operator can finish it without losing otherwise valid graph structure.
func HasUnboundCapabilityIdentity(report BindingReport) bool {
	for _, missing := range report.Missing {
		switch missing.Reason {
		case "exact_tool_not_found",
			"exact_mcp_tool_not_found",
			"exact_credential_not_found",
			"exact_subworkflow_not_eligible",
			"subworkflow_version_not_found",
			"node_type_not_executable":
			return true
		}
	}
	return false
}

func BindWorkflowJSON(catalog Catalog, document map[string]any) (BindingReport, *domain.Workflow, []domain.Issue) {
	raw, err := json.Marshal(document)
	if err != nil {
		return BindingReport{CatalogVersion: catalog.Version, Resolved: []Binding{}, Missing: []Binding{{Kind: "workflow", Field: "workflow", Alternatives: []string{}, Reason: "workflow_not_serializable"}}, Complete: false}, nil, nil
	}
	workflow, parseIssues := domain.Parse(raw)
	if workflow == nil {
		return BindingReport{CatalogVersion: catalog.Version, Resolved: []Binding{}, Missing: []Binding{{Kind: "workflow", Field: "workflow", Alternatives: []string{}, Reason: "workflow_contract_invalid"}}, Complete: false}, nil, parseIssues
	}
	return BindWorkflow(catalog, workflow), workflow, parseIssues
}

// bindingForWire keeps the authoring response contract stable for incomplete
// proposals. A nil slice marshals as JSON null, but every UI/MCP/OpenAPI
// consumer treats alternatives as an iterable array, including when there are
// no safe suggestions. Normalize at the producer boundary instead of teaching
// each consumer to accept two wire shapes.
func bindingForWire(binding Binding) Binding {
	if binding.Alternatives == nil {
		binding.Alternatives = []string{}
	}
	return binding
}

func requireConfig(report *BindingReport, node domain.Node, field string) {
	value := trimmedString(node.Config[field])
	if value == "" {
		report.Missing = append(report.Missing, Binding{Kind: "trigger", NodeID: node.ID, Field: "config." + field, Reason: "trigger_configuration_incomplete", Alternatives: []string{}})
		report.Complete = false
	}
}

func completeWaitUntil(config map[string]any) bool {
	return domain.ValidateWaitUntilConfig(config) == nil
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
	if kind != "" {
		slices.Sort(exact)
		return boundedAlternatives(exact)
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

func agentToolWriteSide(entry tools.CatalogEntry, name string, input map[string]any) bool {
	if !entry.WriteSide {
		return false
	}
	if name != "http.request" {
		return true
	}
	method, ok := input["method"].(string)
	if !ok && input["method"] != nil {
		return true
	}
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case "", "GET", "HEAD", "OPTIONS":
		return false
	default:
		return true
	}
}

func mcpIdentifier(alias, name string) string {
	switch {
	case alias == "":
		return name
	case name == "":
		return alias
	default:
		return alias + "/" + name
	}
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
