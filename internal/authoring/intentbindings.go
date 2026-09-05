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
// nodeFact is the executable identity a proposed node carries: the tool,
// MCP tool or subworkflow it names, and whether that identity writes.
type nodeFact struct {
	ID, Type, Tool, MCP, Subworkflow string
	ToolWrite, MCPWrite, HTTPWrite   bool
	AgentWrite                       bool
}

// collectProposalFacts projects every node (and every multi-agent member)
// to the identity the intent brief can be matched against.
func collectProposalFacts(catalog Catalog, workflow *domain.Workflow) []nodeFact {
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
	return facts
}

// proposalBinder matches an intent brief against the proposed nodes' facts
// and records what the proposal delivers, misses or adds undeclared.
type proposalBinder struct {
	catalog Catalog
	facts   []nodeFact
	report  *BindingReport
}

func (b *proposalBinder) addResolved(binding Binding) {
	if !hasBinding(b.report.Resolved, binding.Kind, binding.Field, binding.Requested) {
		b.report.Resolved = append(b.report.Resolved, bindingForWire(binding))
	}
}
func (b *proposalBinder) addMissing(binding Binding) {
	if !hasBinding(b.report.Missing, binding.Kind, binding.Field, binding.Requested) {
		b.report.Missing = append(b.report.Missing, bindingForWire(binding))
	}
	b.report.Complete = false
}
func (b *proposalBinder) find(predicate func(nodeFact) bool) (nodeFact, bool) {
	for _, fact := range b.facts {
		if predicate(fact) {
			return fact, true
		}
	}
	return nodeFact{}, false
}
func (b *proposalBinder) require(kind, field, requested string, alternatives []string, predicate func(nodeFact) bool) {
	if fact, ok := b.find(predicate); ok {
		b.addResolved(Binding{Kind: kind, NodeID: fact.ID, Field: field, Requested: requested, ResolvedID: requested, Alternatives: []string{}})
		return
	}
	b.addMissing(Binding{Kind: kind, Field: field, Requested: requested, Alternatives: alternatives, Reason: "requested_intent_not_proposed"})
}

// bindIntentTrigger checks the brief's trigger is proposed as the matching node.
func (b *proposalBinder) bindIntentTrigger(brief IntentBrief) {
	triggerTypes := map[string]string{
		"schedule": "schedule", "webhook": "webhook_received", "email": "email_received",
		"file": "file_dropped", "mcp_event": "mcp_server_event", "pagerduty": "pagerduty_incident",
	}
	if brief.Trigger != "" && brief.Trigger != "manual" {
		if nodeType, supported := triggerTypes[brief.Trigger]; supported {
			b.require("intent_trigger", "brief.trigger", brief.Trigger, []string{nodeType}, func(f nodeFact) bool { return f.Type == nodeType })
		} else {
			b.addMissing(Binding{Kind: "intent_trigger", Field: "brief.trigger", Requested: brief.Trigger, Alternatives: sortedTriggerIDs(b.catalog), Reason: "requested_trigger_not_supported"})
		}
	}
}

// bindIntentEffects checks every declared external effect is delivered by a
// proposed write-capable identity.
func (b *proposalBinder) bindIntentEffects(brief IntentBrief) {
	for _, effect := range brief.ExternalEffects {
		switch effect {
		case "slack_message":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"slack.post"}, func(f nodeFact) bool { return f.Tool == "slack.post" })
		case "github_issue":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"github.create_issue"}, func(f nodeFact) bool { return f.Tool == "github.create_issue" })
		case "email_delivery":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"email.send"}, func(f nodeFact) bool { return f.Tool == "email.send" })
		case "outbound_webhook":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"webhook.send", "http POST"}, func(f nodeFact) bool { return f.Tool == "webhook.send" || f.HTTPWrite })
		case "database_write":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"db.query.write", "db.query.transaction"}, func(f nodeFact) bool {
				return f.Tool == "db.query.write" || f.Tool == "db.query.transaction"
			})
		case "pagerduty_acknowledge":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"pagerduty.incident.acknowledge"}, func(f nodeFact) bool {
				return f.Tool == "pagerduty.incident.acknowledge"
			})
		case "pagerduty_snooze":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"pagerduty.incident.snooze"}, func(f nodeFact) bool {
				return f.Tool == "pagerduty.incident.snooze"
			})
		case "sheet_append":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"sheet.append"}, func(f nodeFact) bool {
				return f.Tool == "sheet.append"
			})
		case "vector_memory_write":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"vector.upsert"}, func(f nodeFact) bool {
				return f.Tool == "vector.upsert"
			})
		case "pdf_generation":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"pdf.generate"}, func(f nodeFact) bool {
				return f.Tool == "pdf.generate"
			})
		case "mcp_write":
			b.require("intent_effect", "brief.externalEffects", effect, sortedMcpNames(b.catalog), func(f nodeFact) bool {
				return f.MCPWrite
			})
		case "agent_write":
			b.require("intent_effect", "brief.externalEffects", effect, []string{"agent with allowWriteTools"}, func(f nodeFact) bool {
				return f.AgentWrite
			})
		default:
			switch {
			case strings.HasPrefix(effect, "tool:"):
				name := strings.TrimSpace(strings.TrimPrefix(effect, "tool:"))
				b.require("intent_effect", "brief.externalEffects", effect, []string{name}, func(f nodeFact) bool {
					return f.Tool == name && f.ToolWrite
				})
			case strings.HasPrefix(effect, "mcp:"):
				identifier := strings.TrimSpace(strings.TrimPrefix(effect, "mcp:"))
				b.require("intent_effect", "brief.externalEffects", effect, []string{identifier}, func(f nodeFact) bool {
					return f.MCP == identifier && f.MCPWrite
				})
			case strings.HasPrefix(effect, "subworkflow:"):
				workflowID := strings.TrimSpace(strings.TrimPrefix(effect, "subworkflow:"))
				b.require("intent_effect", "brief.externalEffects", effect, []string{workflowID}, func(f nodeFact) bool {
					return workflowID != "" && f.Subworkflow == workflowID
				})
			default:
				b.addMissing(Binding{Kind: "intent_effect", Field: "brief.externalEffects", Requested: effect, Alternatives: []string{}, Reason: "requested_effect_not_supported"})
			}
		}
	}
}

// reportUndeclaredEffects flags proposed writes the brief did not declare;
// unknown write tools and subworkflows fail closed until named exactly.
func (b *proposalBinder) reportUndeclaredEffects(brief IntentBrief) {
	declaredEffects := make(map[string]bool, len(brief.ExternalEffects))
	for _, effect := range brief.ExternalEffects {
		declaredEffects[effect] = true
	}
	for _, fact := range b.facts {
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
			// mutable transitive authority from a bounded b.catalog projection.
			proposedEffect = "subworkflow:" + fact.Subworkflow
		}
		if proposedEffect != "" && !declaredEffects[proposedEffect] {
			b.addMissing(Binding{
				Kind: "proposal_effect", NodeID: fact.ID, Field: "brief.externalEffects",
				Requested: proposedEffect, Alternatives: []string{proposedEffect}, Reason: "proposed_effect_not_declared",
			})
		}
	}
}

// bindIntentApprovals and bindIntentCapabilities check the brief's approvals
// and every capability the intent text names against the proposal.
func (b *proposalBinder) bindIntentApprovals(brief IntentBrief) {
	if len(brief.Approvals) > 0 {
		b.require("intent_approval", "brief.approvals", strings.Join(brief.Approvals, ","), []string{"approval", "human_form"}, func(f nodeFact) bool {
			return f.Type == "approval" || f.Type == "human_form"
		})
	}
}

func (b *proposalBinder) bindIntentCapabilities(brief IntentBrief) {
	intentText := strings.ToLower(strings.Join([]string{
		brief.Objective, brief.ExpectedOutcome, strings.Join(brief.Inputs, " "),
		strings.Join(brief.ExternalEffects, " "), strings.Join(brief.Examples, " "),
	}, " "))
	knownTools := map[string]bool{}
	for _, entry := range b.catalog.BuiltinTools {
		knownTools[strings.ToLower(entry.Name)] = true
		if strings.Contains(intentText, strings.ToLower(entry.Name)) {
			name := entry.Name
			b.require("intent_capability", "brief.objective", name, []string{name}, func(f nodeFact) bool { return f.Tool == name })
		}
	}
	for _, match := range explicitToolPattern.FindAllStringSubmatch(intentText, -1) {
		requested := strings.ToLower(match[1])
		if !knownTools[requested] {
			b.addMissing(Binding{Kind: "intent_capability", Field: "brief.objective", Requested: requested, Alternatives: sortedBuiltinNames(b.catalog), Reason: "requested_tool_not_in_catalog"})
		}
	}

	knownMCP := map[string]bool{}
	for _, entry := range b.catalog.McpTools {
		if entry.ConnectionAlias == "_truncated" || entry.ToolName == "_truncated" {
			continue
		}
		identifier := entry.ConnectionAlias + "/" + entry.ToolName
		knownMCP[strings.ToLower(identifier)] = true
		if strings.Contains(intentText, strings.ToLower(identifier)) {
			b.require("intent_capability", "brief.objective", identifier, []string{identifier}, func(f nodeFact) bool { return f.MCP == identifier })
		}
	}
	for _, match := range explicitMCPPattern.FindAllStringSubmatch(intentText, -1) {
		requested := strings.ToLower(match[1])
		if !knownMCP[requested] {
			b.addMissing(Binding{Kind: "intent_capability", Field: "brief.objective", Requested: requested, Alternatives: sortedMcpNames(b.catalog), Reason: "requested_mcp_not_in_catalog"})
		}
	}

	for _, entry := range b.catalog.Subworkflows {
		if strings.Contains(intentText, strings.ToLower(entry.WorkflowID)) {
			workflowID := entry.WorkflowID
			b.require("intent_capability", "brief.objective", workflowID, []string{workflowID}, func(f nodeFact) bool { return f.Subworkflow == workflowID })
		}
	}
}

// BindProposal binds the workflow like BindWorkflow, then checks the
// proposal against the intent brief it claims to implement.
func BindProposal(catalog Catalog, brief IntentBrief, workflow *domain.Workflow) BindingReport {
	report := BindWorkflow(catalog, workflow)
	if workflow == nil {
		return report
	}
	b := &proposalBinder{catalog: catalog, facts: collectProposalFacts(catalog, workflow), report: &report}
	b.bindIntentTrigger(brief)
	b.bindIntentEffects(brief)
	b.reportUndeclaredEffects(brief)
	b.bindIntentApprovals(brief)
	b.bindIntentCapabilities(brief)
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
