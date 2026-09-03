package authoring

import (
	"regexp"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/domain"
)

var (
	explicitToolPattern = regexp.MustCompile(`(?i)(?:\btool\b|\bherramienta\b)\s+["']?([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+)`)
	explicitMCPPattern  = regexp.MustCompile(`(?i)\bmcp(?:\s+tool|\s+herramienta)?\s+["']?([a-z][a-z0-9_-]*/[a-z][a-z0-9_.-]*)`)
)

// BindProposal extends exact graph binding with an intent-satisfaction gate.
// A syntactically valid graph is not applicable when it silently omits the
// requested trigger, effect, approval, or exact catalog capability. Missing
// requirements remain explicit; this function never inserts or rewrites a
// node and therefore cannot turn model prose into execution authority.
func BindProposal(catalog Catalog, brief IntentBrief, workflow *domain.Workflow) BindingReport {
	report := BindWorkflow(catalog, workflow)
	if workflow == nil {
		return report
	}

	type nodeFact struct {
		ID, Type, Tool, MCP, Subworkflow string
		ToolWrite, MCPWrite, HTTPWrite   bool
		AgentWrite                       bool
	}
	builtinWrite := map[string]bool{}
	for _, entry := range catalog.BuiltinTools {
		builtinWrite[entry.Name] = entry.WriteSide
	}
	mcpWrite := map[string]bool{}
	for _, entry := range catalog.McpTools {
		mcpWrite[entry.ConnectionAlias+"/"+entry.ToolName] = entry.WriteSide
	}
	toolFact := func(node domain.Node, tool string, input map[string]any, writesAuthorized bool) nodeFact {
		fact := nodeFact{ID: node.ID, Type: node.Type, Tool: tool}
		fact.ToolWrite = builtinWrite[tool]
		if tool == "http.request" {
			method := strings.ToUpper(trimmedString(input["method"]))
			fact.HTTPWrite = method != "" && method != "GET" && method != "HEAD" && method != "OPTIONS"
			fact.ToolWrite = fact.HTTPWrite
		}
		if !writesAuthorized {
			fact.ToolWrite = false
			fact.HTTPWrite = false
		}
		return fact
	}
	facts := make([]nodeFact, 0, len(workflow.Nodes)*2)
	for _, node := range workflow.Nodes {
		fact := nodeFact{ID: node.ID, Type: node.Type}
		switch node.Type {
		case "tool":
			input, _ := node.Config["input"].(map[string]any)
			fact = toolFact(node, trimmedString(node.Config["tool"]), input, true)
		case "loop":
			if trimmedString(node.Config["mode"]) == "for_each" {
				input, _ := node.Config["input"].(map[string]any)
				fact = toolFact(node, trimmedString(node.Config["tool"]), input, true)
			}
		case "agent":
			allowWrites, _ := node.Config["allowWriteTools"].(bool)
			tool, input, _ := domain.AgentConfiguredTool(node.Config)
			if tool != "" {
				fact = toolFact(node, tool, input, allowWrites)
			} else if allowWrites {
				fact.AgentWrite = true
			}
		case "multi_agent":
			facts = append(facts, fact)
			resolved, err := domain.ResolveMultiAgentRuntimeConfig(node.Config)
			if err != nil {
				continue
			}
			allowWrites, _ := node.Config["allowWriteTools"].(bool)
			for _, raw := range resolved.Agents {
				member, _ := raw.(map[string]any)
				tool, input, _ := domain.AgentConfiguredTool(member)
				if tool != "" {
					facts = append(facts, toolFact(node, tool, input, allowWrites))
				} else if allowWrites {
					facts = append(facts, nodeFact{ID: node.ID, Type: node.Type, AgentWrite: true})
				}
			}
			continue
		case "mcp_tool":
			fact.MCP = trimmedString(node.Config["connectionAlias"]) + "/" + trimmedString(node.Config["toolName"])
			fact.MCPWrite = mcpWrite[fact.MCP]
		case "subworkflow":
			fact.Subworkflow = trimmedString(node.Config["workflowId"])
		case "http":
			method := strings.ToUpper(trimmedString(node.Config["method"]))
			fact.HTTPWrite = method != "" && method != "GET" && method != "HEAD" && method != "OPTIONS"
		}
		facts = append(facts, fact)
	}

	addResolved := func(binding Binding) {
		if !hasBinding(report.Resolved, binding.Kind, binding.Field, binding.Requested) {
			report.Resolved = append(report.Resolved, bindingForWire(binding))
		}
	}
	addMissing := func(binding Binding) {
		if !hasBinding(report.Missing, binding.Kind, binding.Field, binding.Requested) {
			report.Missing = append(report.Missing, bindingForWire(binding))
		}
		report.Complete = false
	}
	find := func(predicate func(nodeFact) bool) (nodeFact, bool) {
		for _, fact := range facts {
			if predicate(fact) {
				return fact, true
			}
		}
		return nodeFact{}, false
	}
	require := func(kind, field, requested string, alternatives []string, predicate func(nodeFact) bool) {
		if fact, ok := find(predicate); ok {
			addResolved(Binding{Kind: kind, NodeID: fact.ID, Field: field, Requested: requested, ResolvedID: requested, Alternatives: []string{}})
			return
		}
		addMissing(Binding{Kind: kind, Field: field, Requested: requested, Alternatives: alternatives, Reason: "requested_intent_not_proposed"})
	}

	triggerTypes := map[string]string{
		"schedule": "schedule", "webhook": "webhook_received", "email": "email_received",
		"file": "file_dropped", "mcp_event": "mcp_server_event", "pagerduty": "pagerduty_incident",
	}
	if brief.Trigger != "" && brief.Trigger != "manual" {
		if nodeType, supported := triggerTypes[brief.Trigger]; supported {
			require("intent_trigger", "brief.trigger", brief.Trigger, []string{nodeType}, func(f nodeFact) bool { return f.Type == nodeType })
		} else {
			addMissing(Binding{Kind: "intent_trigger", Field: "brief.trigger", Requested: brief.Trigger, Alternatives: sortedTriggerIDs(catalog), Reason: "requested_trigger_not_supported"})
		}
	}

	for _, effect := range brief.ExternalEffects {
		switch effect {
		case "slack_message":
			require("intent_effect", "brief.externalEffects", effect, []string{"slack.post"}, func(f nodeFact) bool { return f.Tool == "slack.post" })
		case "github_issue":
			require("intent_effect", "brief.externalEffects", effect, []string{"github.create_issue"}, func(f nodeFact) bool { return f.Tool == "github.create_issue" })
		case "email_delivery":
			require("intent_effect", "brief.externalEffects", effect, []string{"email.send"}, func(f nodeFact) bool { return f.Tool == "email.send" })
		case "outbound_webhook":
			require("intent_effect", "brief.externalEffects", effect, []string{"webhook.send", "http POST"}, func(f nodeFact) bool { return f.Tool == "webhook.send" || f.HTTPWrite })
		case "database_write":
			require("intent_effect", "brief.externalEffects", effect, []string{"db.query.write", "db.query.transaction"}, func(f nodeFact) bool {
				return f.Tool == "db.query.write" || f.Tool == "db.query.transaction"
			})
		case "pagerduty_acknowledge":
			require("intent_effect", "brief.externalEffects", effect, []string{"pagerduty.incident.acknowledge"}, func(f nodeFact) bool {
				return f.Tool == "pagerduty.incident.acknowledge"
			})
		case "pagerduty_snooze":
			require("intent_effect", "brief.externalEffects", effect, []string{"pagerduty.incident.snooze"}, func(f nodeFact) bool {
				return f.Tool == "pagerduty.incident.snooze"
			})
		case "sheet_append":
			require("intent_effect", "brief.externalEffects", effect, []string{"sheet.append"}, func(f nodeFact) bool {
				return f.Tool == "sheet.append"
			})
		case "vector_memory_write":
			require("intent_effect", "brief.externalEffects", effect, []string{"vector.upsert"}, func(f nodeFact) bool {
				return f.Tool == "vector.upsert"
			})
		case "pdf_generation":
			require("intent_effect", "brief.externalEffects", effect, []string{"pdf.generate"}, func(f nodeFact) bool {
				return f.Tool == "pdf.generate"
			})
		case "mcp_write":
			require("intent_effect", "brief.externalEffects", effect, sortedMcpNames(catalog), func(f nodeFact) bool {
				return f.MCPWrite
			})
		case "agent_write":
			require("intent_effect", "brief.externalEffects", effect, []string{"agent with allowWriteTools"}, func(f nodeFact) bool {
				return f.AgentWrite
			})
		default:
			switch {
			case strings.HasPrefix(effect, "tool:"):
				name := strings.TrimSpace(strings.TrimPrefix(effect, "tool:"))
				require("intent_effect", "brief.externalEffects", effect, []string{name}, func(f nodeFact) bool {
					return f.Tool == name && f.ToolWrite
				})
			case strings.HasPrefix(effect, "mcp:"):
				identifier := strings.TrimSpace(strings.TrimPrefix(effect, "mcp:"))
				require("intent_effect", "brief.externalEffects", effect, []string{identifier}, func(f nodeFact) bool {
					return f.MCP == identifier && f.MCPWrite
				})
			case strings.HasPrefix(effect, "subworkflow:"):
				workflowID := strings.TrimSpace(strings.TrimPrefix(effect, "subworkflow:"))
				require("intent_effect", "brief.externalEffects", effect, []string{workflowID}, func(f nodeFact) bool {
					return workflowID != "" && f.Subworkflow == workflowID
				})
			default:
				addMissing(Binding{Kind: "intent_effect", Field: "brief.externalEffects", Requested: effect, Alternatives: []string{}, Reason: "requested_effect_not_supported"})
			}
		}
	}
	declaredEffects := make(map[string]bool, len(brief.ExternalEffects))
	for _, effect := range brief.ExternalEffects {
		declaredEffects[effect] = true
	}
	for _, fact := range facts {
		proposedEffect := ""
		switch fact.Tool {
		case "slack.post":
			proposedEffect = "slack_message"
		case "github.create_issue":
			proposedEffect = "github_issue"
		case "email.send":
			proposedEffect = "email_delivery"
		case "webhook.send":
			proposedEffect = "outbound_webhook"
		case "db.query.write", "db.query.transaction":
			proposedEffect = "database_write"
		case "pagerduty.incident.acknowledge":
			proposedEffect = "pagerduty_acknowledge"
		case "pagerduty.incident.snooze":
			proposedEffect = "pagerduty_snooze"
		case "sheet.append":
			proposedEffect = "sheet_append"
		case "vector.upsert":
			proposedEffect = "vector_memory_write"
		case "pdf.generate":
			proposedEffect = "pdf_generation"
		}
		if proposedEffect == "" && fact.HTTPWrite {
			proposedEffect = "outbound_webhook"
		}
		if proposedEffect == "" && fact.MCPWrite {
			proposedEffect = "mcp_write"
		}
		if proposedEffect == "" && fact.AgentWrite {
			proposedEffect = "agent_write"
		}
		if proposedEffect == "" && fact.ToolWrite {
			// Future registered write tools fail closed until the operator names
			// their exact capability as externalEffects: ["tool:<name>"].
			proposedEffect = "tool:" + fact.Tool
		}
		if proposedEffect == "" && fact.Subworkflow != "" {
			// A subworkflow is a delegation boundary: following latest can change
			// its transitive effects after this proposal was reviewed, and a pinned
			// child can still perform writes hidden from the parent graph. Require
			// the exact child id in the Intent Brief rather than trying to infer
			// mutable transitive authority from a bounded catalog projection.
			proposedEffect = "subworkflow:" + fact.Subworkflow
		}
		if proposedEffect != "" && !declaredEffects[proposedEffect] {
			addMissing(Binding{
				Kind: "proposal_effect", NodeID: fact.ID, Field: "brief.externalEffects",
				Requested: proposedEffect, Alternatives: []string{proposedEffect}, Reason: "proposed_effect_not_declared",
			})
		}
	}
	if len(brief.Approvals) > 0 {
		require("intent_approval", "brief.approvals", strings.Join(brief.Approvals, ","), []string{"approval", "human_form"}, func(f nodeFact) bool {
			return f.Type == "approval" || f.Type == "human_form"
		})
	}

	intentText := strings.ToLower(strings.Join([]string{
		brief.Objective, brief.ExpectedOutcome, strings.Join(brief.Inputs, " "),
		strings.Join(brief.ExternalEffects, " "), strings.Join(brief.Examples, " "),
	}, " "))
	knownTools := map[string]bool{}
	for _, entry := range catalog.BuiltinTools {
		knownTools[strings.ToLower(entry.Name)] = true
		if strings.Contains(intentText, strings.ToLower(entry.Name)) {
			name := entry.Name
			require("intent_capability", "brief.objective", name, []string{name}, func(f nodeFact) bool { return f.Tool == name })
		}
	}
	for _, match := range explicitToolPattern.FindAllStringSubmatch(intentText, -1) {
		requested := strings.ToLower(match[1])
		if !knownTools[requested] {
			addMissing(Binding{Kind: "intent_capability", Field: "brief.objective", Requested: requested, Alternatives: sortedBuiltinNames(catalog), Reason: "requested_tool_not_in_catalog"})
		}
	}

	knownMCP := map[string]bool{}
	for _, entry := range catalog.McpTools {
		if entry.ConnectionAlias == "_truncated" || entry.ToolName == "_truncated" {
			continue
		}
		identifier := entry.ConnectionAlias + "/" + entry.ToolName
		knownMCP[strings.ToLower(identifier)] = true
		if strings.Contains(intentText, strings.ToLower(identifier)) {
			require("intent_capability", "brief.objective", identifier, []string{identifier}, func(f nodeFact) bool { return f.MCP == identifier })
		}
	}
	for _, match := range explicitMCPPattern.FindAllStringSubmatch(intentText, -1) {
		requested := strings.ToLower(match[1])
		if !knownMCP[requested] {
			addMissing(Binding{Kind: "intent_capability", Field: "brief.objective", Requested: requested, Alternatives: sortedMcpNames(catalog), Reason: "requested_mcp_not_in_catalog"})
		}
	}

	for _, entry := range catalog.Subworkflows {
		if strings.Contains(intentText, strings.ToLower(entry.WorkflowID)) {
			workflowID := entry.WorkflowID
			require("intent_capability", "brief.objective", workflowID, []string{workflowID}, func(f nodeFact) bool { return f.Subworkflow == workflowID })
		}
	}
	return report
}

func hasBinding(bindings []Binding, kind, field, requested string) bool {
	for _, binding := range bindings {
		if binding.Kind == kind && binding.Field == field && binding.Requested == requested {
			return true
		}
	}
	return false
}

func sortedTriggerIDs(catalog Catalog) []string {
	values := make([]string, 0, len(catalog.Triggers))
	for _, trigger := range catalog.Triggers {
		values = append(values, trigger.ID)
	}
	slices.Sort(values)
	return boundedAlternatives(values)
}
