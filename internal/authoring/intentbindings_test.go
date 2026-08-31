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
