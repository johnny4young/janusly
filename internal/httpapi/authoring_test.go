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
		{name: "loop tool", unsafe: "invented.batch", node: map[string]any{
			"id": "step", "type": "loop", "config": map[string]any{
				"mode": "for_each", "tool": "invented.batch", "items": []any{"x"}, "input": map[string]any{},
			},
		}},
		{name: "agent tool", unsafe: "invented.agent", node: map[string]any{
			"id": "step", "type": "agent", "config": map[string]any{
				"goal": "Inspect", "tool": "invented.agent", "input": map[string]any{},
			},
		}},
		{name: "multi-agent member tool", unsafe: "invented.member", node: map[string]any{
			"id": "step", "type": "multi_agent", "config": map[string]any{
				"agents": []any{map[string]any{"goal": "Inspect", "tool": "invented.member", "input": map[string]any{}}},
			},
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

func TestFinalizeAuthoringProposalReturnsCanonicalInspectedWorkflow(t *testing.T) {
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "canonical-test")
	brief := authoring.IntentBrief{
		Version: "1", Objective: "Prepare a local result", Trigger: "manual", Language: "en",
	}
	document := proposalTestDocument(map[string]any{
		"id": " step ", "type": " noop ", "config": map[string]any{}, "providerOnly": true,
	})
	document["providerOnly"] = "must-not-reach-apply"
	document["metadata"] = map[string]any{
		"description": "  Canonical description  ", "tags": []any{" reviewed "}, "owner": "provider",
	}
	document["ui"] = map[string]any{
		"positions":     map[string]any{" step ": map[string]any{"x": 12.0, "y": 34.0, "z": 99.0}},
		"providerPanel": true,
	}

	finalized := finalizeAuthoringProposal("Prepare a local result", brief, catalog, document, "ai")
	if finalized.ProviderGuarded || finalized.Workflow == nil {
		t.Fatalf("safe provider workflow unexpectedly guarded: %+v", finalized)
	}
	raw, err := json.Marshal(finalized.WorkflowDoc)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(raw)
	for _, forbidden := range []string{"providerOnly", "must-not-reach-apply", `"owner"`, "providerPanel", `"z"`} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("proposal returned uninspected provider field %q: %s", forbidden, raw)
		}
	}
	if !strings.Contains(serialized, `"id":"step"`) || !strings.Contains(serialized, `"type":"noop"`) ||
		!strings.Contains(serialized, `"description":"Canonical description"`) ||
		!strings.Contains(serialized, `"tags":["reviewed"]`) ||
		!strings.Contains(serialized, `"positions":{"step":{"x":12,"y":34}}`) {
		t.Fatalf("proposal did not return the normalized workflow inspected by binding/readiness: %s", raw)
	}
}

func TestFinalizeAuthoringProposalDiscardsProviderSecretMaterial(t *testing.T) {
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "secret-guard-test")
	brief := authoring.IntentBrief{
		Version: "1", Objective: "Prepare a local result", Trigger: "manual", Language: "en",
	}
	document := proposalTestDocument(map[string]any{
		"id": "step", "type": "noop", "config": map[string]any{
			"authorization": "Bearer provider-invented-secret",
		},
	})

	finalized := finalizeAuthoringProposal("Prepare a local result", brief, catalog, document, "ai")
	if !finalized.ProviderGuarded || finalized.GuardReason != "unsafe_provider_secret_material" ||
		finalized.Mode != "fallback" || finalized.Workflow == nil || finalized.Workflow.ID != "capability-binding-required" ||
		finalized.Bindings.Complete || !bindingReasonPresent(finalized.Bindings, "unsafe_provider_secret_material") {
		t.Fatalf("provider secret material must fail closed: %+v", finalized)
	}
	raw, err := json.Marshal(finalized.WorkflowDoc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "provider-invented-secret") {
		t.Fatalf("guarded graph retained provider secret material: %s", raw)
	}

	safeReference := proposalTestDocument(map[string]any{
		"id": "step", "type": "noop", "config": map[string]any{
			"authorization": "{{secret.API_TOKEN}}",
		},
	})
	if safe := finalizeAuthoringProposal("Prepare a local result", brief, catalog, safeReference, "ai"); safe.ProviderGuarded {
		t.Fatalf("a supported secret reference must remain reviewable: %+v", safe)
	}
}

func TestFinalizeAuthoringProposalDiscardsUndeclaredProviderEffect(t *testing.T) {
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "guard-test")
	brief := authoring.IntentBrief{
		Version: "1", Objective: "Prepare a local report", Trigger: "manual",
		ExternalEffects: []string{}, Language: "en",
	}
	document := proposalTestDocument(map[string]any{
		"id": "step", "type": "http", "config": map[string]any{
			"url": "https://example.test/actions", "method": "POST", "body": map[string]any{"action": "mutate"},
		},
	})
	finalized := finalizeAuthoringProposal("Prepare a local report", brief, catalog, document, "ai")
	if !finalized.ProviderGuarded || finalized.GuardReason != "unsafe_provider_effect_expansion" ||
		finalized.Mode != "fallback" || finalized.Workflow == nil || finalized.Workflow.ID != "capability-binding-required" ||
		finalized.Bindings.Complete || !bindingReasonPresent(finalized.Bindings, "unsafe_provider_effect_expansion") {
		t.Fatalf("undeclared provider effect must fail closed: %+v", finalized)
	}
	raw, err := json.Marshal(finalized.WorkflowDoc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "example.test") || strings.Contains(string(raw), `"method":"POST"`) {
		t.Fatalf("guarded graph retained the undeclared mutation: %s", raw)
	}
}

func TestFinalizeAuthoringProposalDiscardsUndeclaredCatalogWrites(t *testing.T) {
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "guard-test")
	catalog.McpTools = []mcpclient.ExposedMcpTool{{
		ConnectionAlias: "crm", ToolName: "contacts.update", WriteSide: true,
	}}
	brief := authoring.IntentBrief{
		Version: "1", Objective: "Prepare a local preview", Trigger: "manual",
		ExternalEffects: []string{}, Language: "en",
	}
	tests := []struct {
		name, forbidden string
		node            map[string]any
	}{
		{name: "registered built-in write", forbidden: "vector.upsert", node: map[string]any{
			"id": "step", "type": "tool", "config": map[string]any{
				"tool": "vector.upsert", "input": map[string]any{"content": "unrequested memory mutation"},
			},
		}},
		{name: "loop built-in write", forbidden: "vector.upsert", node: map[string]any{
			"id": "step", "type": "loop", "config": map[string]any{
				"mode": "for_each", "tool": "vector.upsert", "items": []any{"fact"},
				"input": map[string]any{"content": "{{item}}"},
			},
		}},
		{name: "agent built-in write", forbidden: "vector.upsert", node: map[string]any{
			"id": "step", "type": "agent", "config": map[string]any{
				"goal": "Remember", "allowWriteTools": true, "tool": "vector.upsert",
				"input": map[string]any{"content": "fact"},
			},
		}},
		{name: "planner-selected agent write", forbidden: "allowWriteTools", node: map[string]any{
			"id": "step", "type": "agent", "config": map[string]any{
				"goal": "Choose an operational action", "allowWriteTools": true,
			},
		}},
		{name: "tenant MCP write", forbidden: "contacts.update", node: map[string]any{
			"id": "step", "type": "mcp_tool", "config": map[string]any{
				"connectionAlias": "crm", "toolName": "contacts.update", "input": map[string]any{},
			},
		}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			finalized := finalizeAuthoringProposal(
				"Prepare a local preview", brief, catalog, proposalTestDocument(testCase.node), "ai",
			)
			if !finalized.ProviderGuarded || finalized.GuardReason != "unsafe_provider_effect_expansion" ||
				finalized.Mode != "fallback" || finalized.Workflow == nil || finalized.Workflow.ID != "capability-binding-required" ||
				finalized.Bindings.Complete || !bindingReasonPresent(finalized.Bindings, "unsafe_provider_effect_expansion") {
				t.Fatalf("undeclared catalog write must fail closed: %+v", finalized)
			}
			raw, err := json.Marshal(finalized.WorkflowDoc)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(raw), testCase.forbidden) {
				t.Fatalf("guarded graph retained undeclared catalog write %q: %s", testCase.forbidden, raw)
			}
		})
	}
}

func TestFinalizeAuthoringProposalDiscardsUndeclaredSubworkflowDelegation(t *testing.T) {
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "guard-test")
	catalog.Subworkflows = []authoring.SubworkflowCapability{{
		WorkflowID: "wf-child", Name: "Child", Status: "active", LatestVersion: 1,
	}}
	brief := authoring.IntentBrief{
		Version: "1", Objective: "Prepare a local preview", Trigger: "manual",
		ExternalEffects: []string{}, Language: "en",
	}
	document := proposalTestDocument(map[string]any{
		"id": "delegate", "type": "subworkflow", "config": map[string]any{"workflowId": "wf-child"},
	})

	finalized := finalizeAuthoringProposal("Prepare a local preview", brief, catalog, document, "ai")
	if !finalized.ProviderGuarded || finalized.GuardReason != "unsafe_provider_effect_expansion" ||
		finalized.Mode != "fallback" || finalized.Workflow == nil || finalized.Workflow.ID != "capability-binding-required" ||
		finalized.Bindings.Complete || !bindingReasonPresent(finalized.Bindings, "unsafe_provider_effect_expansion") {
		t.Fatalf("undeclared subworkflow delegation must fail closed: %+v", finalized)
	}
	raw, err := json.Marshal(finalized.WorkflowDoc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "wf-child") {
		t.Fatalf("guarded graph retained undeclared subworkflow authority: %s", raw)
	}
}

func TestFinalizeAuthoringProposalAcceptsDeclaredSubworkflowDelegation(t *testing.T) {
	catalog := authoring.NewBuilder(nil, nil).Build(t.Context(), "guard-test")
	catalog.Subworkflows = []authoring.SubworkflowCapability{{
		WorkflowID: "wf-child", Name: "Child", Status: "active", LatestVersion: 1,
	}}
	brief := authoring.IntentBrief{
		Version: "1", Objective: "Delegate to the reviewed child", Trigger: "manual",
		ExternalEffects: []string{"subworkflow:wf-child"}, Language: "en",
	}
	document := proposalTestDocument(map[string]any{
		"id": "delegate", "type": "subworkflow", "config": map[string]any{"workflowId": "wf-child", "version": 1},
	})

	finalized := finalizeAuthoringProposal("Delegate to the reviewed child", brief, catalog, document, "ai")
	if finalized.ProviderGuarded || finalized.Mode != "ai" || finalized.Workflow == nil || !finalized.Bindings.Complete {
		t.Fatalf("exact declared subworkflow delegation rejected: %+v", finalized)
	}
}

func proposalTestDocument(node map[string]any) map[string]any {
	return map[string]any{
		"dslVersion": "1.0", "id": "provider-draft", "name": "Provider draft",
		"outputs": map[string]any{"result": "{{context.step.output}}"},
		"nodes":   []any{node}, "edges": []any{},
	}
}
