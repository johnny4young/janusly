package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/mcpclient"
)

func TestFinalizeAuthoringProposalDiscardsUncataloguedAIIdentities(t *testing.T) {
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "guard-test")
	catalog.Version = "guard-catalog-v1"
	catalog.McpTools = []mcpclient.ExposedMcpTool{{ConnectionAlias: "crm", ToolName: "contacts.lookup"}}
	catalog.Credentials = []authoring.CredentialCapability{{
		ID: "cred-slack", Name: "incidents-slack", Kind: "slack_webhook", Configured: true, UpdatedAt: time.Unix(0, 0),
	}}
	catalog.Subworkflows = []authoring.SubworkflowCapability{{
		WorkflowID: "wf-child", Name: "Child", Status: "active", LatestVersion: 1,
	}}
	brief := authoring.IntentBrief{Version: "1", Objective: "Prepare a result", Trigger: "manual", Language: "en"}

	tests := []struct {
		name, unsafe string
		node         map[string]any
	}{
		{name: "tool", unsafe: "invented.send", node: map[string]any{
			"id": "step", "type": "tool", "config": map[string]any{"tool": "invented.send", "input": map[string]any{}},
		}},
		{name: "mcp", unsafe: "contacts.delete", node: map[string]any{
			"id": "step", "type": "mcp_tool", "config": map[string]any{"connectionAlias": "crm", "toolName": "contacts.delete"},
		}},
		{name: "credential", unsafe: "invented-credential", node: map[string]any{
			"id": "step", "type": "tool", "config": map[string]any{
				"tool": "slack.post", "input": map[string]any{"credential": "invented-credential"},
			},
		}},
		{name: "subworkflow", unsafe: "wf-invented", node: map[string]any{
			"id": "step", "type": "subworkflow", "config": map[string]any{"workflowId": "wf-invented"},
		}},
		{name: "subworkflow version", unsafe: `"version":9`, node: map[string]any{
			"id": "step", "type": "subworkflow", "config": map[string]any{"workflowId": "wf-child", "version": 9},
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			document := proposalTestDocument(testCase.node)
			finalized := finalizeAuthoringProposal("Prepare a result", brief, catalog, document, "ai")
			if !finalized.ProviderGuarded || finalized.Mode != "fallback" || finalized.Workflow == nil || finalized.Bindings.Complete {
				t.Fatalf("uncatalogued identity must fail closed: %+v", finalized)
			}
			raw, err := json.Marshal(finalized.WorkflowDoc)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(raw), testCase.unsafe) || finalized.Workflow.ID != "capability-binding-required" ||
				authoring.HasUnboundCapabilityIdentity(authoring.BindWorkflow(catalog, finalized.Workflow)) {
				t.Fatalf("guarded graph retained an uncatalogued identity: %s", raw)
			}
			if !bindingReasonPresent(finalized.Bindings, "unsafe_provider_capability_reference") {
				t.Fatalf("guard decision must remain explicit: %+v", finalized.Bindings)
			}
		})
	}
}

func TestFinalizeAuthoringProposalPreservesIncompleteConfiguration(t *testing.T) {
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "guard-test")
	brief := authoring.IntentBrief{Version: "1", Objective: "Use tool text.uppercase", Trigger: "manual", Language: "en"}
	document := proposalTestDocument(map[string]any{
		"id": "step", "type": "tool", "config": map[string]any{"tool": "text.uppercase", "input": map[string]any{}},
	})
	finalized := finalizeAuthoringProposal("Use tool text.uppercase", brief, catalog, document, "ai")
	if finalized.ProviderGuarded || finalized.Mode != "ai" || finalized.Workflow == nil || finalized.Workflow.ID != "provider-draft" ||
		finalized.Bindings.Complete || !bindingReasonPresent(finalized.Bindings, "tool_input_required") {
		t.Fatalf("configuration-only gap should preserve the reviewable graph: %+v", finalized)
	}
}

func proposalTestDocument(node map[string]any) map[string]any {
	return map[string]any{
		"dslVersion": "1.0", "id": "provider-draft", "name": "Provider draft",
		"outputs": map[string]any{"result": "{{context.step.output}}"},
		"nodes":   []any{node}, "edges": []any{},
	}
}
