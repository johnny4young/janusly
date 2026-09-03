package authoring

import (
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

func TestBindProposalRejectsSilentlyOmittedIntent(t *testing.T) {
	catalog := bindingTestCatalog()
	workflow := &domain.Workflow{ID: "proposal", Nodes: []domain.Node{{ID: "done", Type: "noop", Config: map[string]any{}}}}
	brief := IntentBrief{
		Objective:       "Every day send a Slack message after human approval",
		Trigger:         "schedule",
		ExternalEffects: []string{"slack_message"},
		Approvals:       []string{"human_approval_before_external_effect"},
	}
	report := BindProposal(catalog, brief, workflow)
	if report.Complete || len(report.Missing) != 3 {
		t.Fatalf("omitted trigger/effect/approval must be explicit: %+v", report)
	}
	var serialized strings.Builder
	for _, binding := range report.Missing {
		serialized.WriteString(binding.Requested + ":" + binding.Reason + " ")
	}
	for _, required := range []string{"schedule", "slack_message", "human_approval_before_external_effect"} {
		if !strings.Contains(serialized.String(), required) {
			t.Fatalf("missing intent requirement %q: %s", required, serialized.String())
		}
	}
}

func TestBindProposalAcceptsExactIntentAndFlagsUnknownNamedCapability(t *testing.T) {
	catalog := bindingTestCatalog()
	workflow := &domain.Workflow{ID: "proposal", Nodes: []domain.Node{
		{ID: "schedule", Type: "schedule", Config: map[string]any{"cronExpression": "0 9 * * *"}},
		{ID: "approve", Type: "approval", Config: map[string]any{"message": "Approve"}},
		{ID: "notify", Type: "tool", Config: map[string]any{
			"tool": "slack.post", "input": map[string]any{"credential": "incidents", "text": "Ready"},
		}},
	}, Edges: []domain.Edge{{From: "schedule", To: "approve"}, {From: "approve", To: "notify"}}}
	brief := IntentBrief{
		Objective:       "Every day use tool slack.post after approval",
		Trigger:         "schedule",
		ExternalEffects: []string{"slack_message"},
		Approvals:       []string{"human_approval_before_external_effect"},
	}
	if report := BindProposal(catalog, brief, workflow); !report.Complete {
		t.Fatalf("exact intent rejected: %+v", report)
	}

	brief.Objective = "Use tool crm.super_power to prepare the result"
	report := BindProposal(catalog, brief, workflow)
	if report.Complete {
		t.Fatalf("unknown named capability must block apply: %+v", report)
	}
	found := false
	for _, binding := range report.Missing {
		found = found || (binding.Requested == "crm.super_power" && binding.Reason == "requested_tool_not_in_catalog")
	}
	if !found {
		t.Fatalf("unknown exact request not surfaced: %+v", report.Missing)
	}
}

func TestBindProposalRejectsEffectsAddedBeyondTheIntentContract(t *testing.T) {
	catalog := bindingTestCatalog()
	tests := []struct {
		name, effect string
		node         domain.Node
	}{
		{name: "known integration", effect: "slack_message", node: domain.Node{
			ID: "notify", Type: "tool", Config: map[string]any{
				"tool": "slack.post", "input": map[string]any{"credential": "incidents", "text": "Ready"},
			},
		}},
		{name: "generic registered write", effect: "vector_memory_write", node: domain.Node{
			ID: "remember", Type: "tool", Config: map[string]any{
				"tool": "vector.upsert", "input": map[string]any{"content": "secretly mutate memory"},
			},
		}},
		{name: "write MCP", effect: "mcp_write", node: domain.Node{
			ID: "update", Type: "mcp_tool", Config: map[string]any{
				"connectionAlias": "crm", "toolName": "contacts.update",
				"input": map[string]any{"contactId": "123"},
			},
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			workflow := &domain.Workflow{ID: "proposal", Nodes: []domain.Node{testCase.node}}
			report := BindProposal(catalog, IntentBrief{
				Objective: "Prepare a local preview", Trigger: "manual", ExternalEffects: []string{},
			}, workflow)
			if report.Complete {
				t.Fatalf("a proposal must not add an undeclared write: %+v", report)
			}
			found := false
			for _, missing := range report.Missing {
				found = found || (missing.Requested == testCase.effect && missing.Reason == "proposed_effect_not_declared")
			}
			if !found {
				t.Fatalf("undeclared proposal effect was not surfaced: %+v", report.Missing)
			}
		})
	}
}

func TestBindProposalAcceptsDeclaredWriteMcpAndGenericToolEffects(t *testing.T) {
	catalog := bindingTestCatalog()
	workflow := &domain.Workflow{ID: "proposal", Nodes: []domain.Node{
		{ID: "remember", Type: "tool", Config: map[string]any{
			"tool": "vector.upsert", "input": map[string]any{"content": "approved memory"},
		}},
		{ID: "update", Type: "mcp_tool", Config: map[string]any{
			"connectionAlias": "crm", "toolName": "contacts.update",
			"input": map[string]any{"contactId": "123"},
		}},
	}}
	report := BindProposal(catalog, IntentBrief{
		Objective: "Store vector memory and use the CRM MCP update",
		Trigger:   "manual", ExternalEffects: []string{"vector_memory_write", "mcp_write"},
	}, workflow)
	if !report.Complete {
		t.Fatalf("declared exact write capabilities rejected: %+v", report)
	}
}

func TestBindProposalRequiresExactSubworkflowDelegation(t *testing.T) {
	catalog := bindingTestCatalog()
	workflow := &domain.Workflow{ID: "proposal", Nodes: []domain.Node{{
		ID: "delegate", Type: "subworkflow", Config: map[string]any{"workflowId": "wf-child", "version": float64(3)},
	}}}

	undeclared := BindProposal(catalog, IntentBrief{
		Objective: "Prepare a local result", Trigger: "manual", ExternalEffects: []string{},
	}, workflow)
	if undeclared.Complete || !bindingReasonRequested(undeclared, "proposed_effect_not_declared", "subworkflow:wf-child") {
		t.Fatalf("subworkflow delegation must be explicit in the brief: %+v", undeclared)
	}

	declared := BindProposal(catalog, IntentBrief{
		Objective: "Delegate to the reviewed child", Trigger: "manual",
		ExternalEffects: []string{"subworkflow:wf-child"},
	}, workflow)
	if !declared.Complete {
		t.Fatalf("exact declared subworkflow delegation rejected: %+v", declared)
	}

	wrongChild := BindProposal(catalog, IntentBrief{
		Objective: "Delegate to a different child", Trigger: "manual",
		ExternalEffects: []string{"subworkflow:wf-other"},
	}, workflow)
	if wrongChild.Complete ||
		!bindingReasonRequested(wrongChild, "requested_intent_not_proposed", "subworkflow:wf-other") ||
		!bindingReasonRequested(wrongChild, "proposed_effect_not_declared", "subworkflow:wf-child") {
		t.Fatalf("subworkflow authority must bind the exact child id: %+v", wrongChild)
	}
}

func TestBindProposalAccountsForNestedAndPlannerSelectedWrites(t *testing.T) {
	catalog := bindingTestCatalog()
	for name, node := range map[string]domain.Node{
		"loop": {ID: "batch", Type: "loop", Config: map[string]any{
			"mode": "for_each", "tool": "vector.upsert", "items": []any{"fact"},
			"input": map[string]any{"content": "{{item}}"},
		}},
		"agent explicit": {ID: "agent", Type: "agent", Config: map[string]any{
			"goal": "Remember", "tool": "vector.upsert", "allowWriteTools": true,
			"input": map[string]any{"content": "fact"},
		}},
		"multi agent explicit": {ID: "crew", Type: "multi_agent", Config: map[string]any{
			"allowWriteTools": true,
			"agents": []any{map[string]any{
				"goal": "Remember", "tool": "vector.upsert", "input": map[string]any{"content": "fact"},
			}},
		}},
	} {
		t.Run(name, func(t *testing.T) {
			report := BindProposal(catalog, IntentBrief{
				Objective: "Prepare a local preview", Trigger: "manual", ExternalEffects: []string{},
			}, &domain.Workflow{Nodes: []domain.Node{node}})
			if report.Complete || !bindingReasonRequested(report, "proposed_effect_not_declared", "vector_memory_write") {
				t.Fatalf("nested write escaped intent binding: %+v", report)
			}
		})
	}

	workflow := &domain.Workflow{Nodes: []domain.Node{{
		ID: "agent", Type: "agent", Config: map[string]any{
			"goal": "Choose a safe operational tool", "allowWriteTools": true,
		},
	}}}
	undeclared := BindProposal(catalog, IntentBrief{
		Objective: "Operate on the incident", Trigger: "manual", ExternalEffects: []string{},
	}, workflow)
	if undeclared.Complete || !bindingReasonRequested(undeclared, "proposed_effect_not_declared", "agent_write") {
		t.Fatalf("planner-selected write authority must be declared: %+v", undeclared)
	}
	declared := BindProposal(catalog, IntentBrief{
		Objective: "Operate on the incident", Trigger: "manual", ExternalEffects: []string{"agent_write"},
	}, workflow)
	if !declared.Complete {
		t.Fatalf("explicit generic agent write authority rejected: %+v", declared)
	}
}

func bindingReasonRequested(report BindingReport, reason, requested string) bool {
	for _, binding := range report.Missing {
		if binding.Reason == reason && binding.Requested == requested {
			return true
		}
	}
	return false
}
