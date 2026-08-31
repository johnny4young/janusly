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
		HTTPWrite                        bool
	}
	facts := make([]nodeFact, 0, len(workflow.Nodes))
	for _, node := range workflow.Nodes {
		fact := nodeFact{ID: node.ID, Type: node.Type}
		switch node.Type {
		case "tool":
			fact.Tool = trimmedString(node.Config["tool"])
		case "mcp_tool":
			fact.MCP = trimmedString(node.Config["connectionAlias"]) + "/" + trimmedString(node.Config["toolName"])
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
			report.Resolved = append(report.Resolved, binding)
		}
	}
	addMissing := func(binding Binding) {
		if !hasBinding(report.Missing, binding.Kind, binding.Field, binding.Requested) {
			report.Missing = append(report.Missing, binding)
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
		"file": "file_dropped", "mcp_event": "mcp_server_event",
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
		default:
			addMissing(Binding{Kind: "intent_effect", Field: "brief.externalEffects", Requested: effect, Alternatives: []string{}, Reason: "requested_effect_not_supported"})
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
