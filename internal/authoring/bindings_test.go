package authoring

import (
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/mcpclient"
	"github.com/johnny4young/janusly/internal/tools"
)

func bindingTestCatalog() Catalog {
	return Catalog{
		Version: "catalog-v1",
		BuiltinTools: []tools.CatalogEntry{
			{Name: "text.uppercase", Required: []string{"value"}},
			{Name: "slack.post", Required: []string{"credential"}, WriteSide: true},
		},
		McpTools: []mcpclient.ExposedMcpTool{{
			ConnectionAlias: "crm", ToolName: "contacts.update",
			InputFields: []mcpclient.ExposedMcpInputField{{Name: "contactId", Type: "string", Required: true}},
		}},
		Credentials: []CredentialCapability{
			{ID: "cred-1", Name: "incidents", Kind: "slack_webhook", Configured: true, UpdatedAt: time.Now()},
			{ID: "cred-expired", Name: "old", Kind: "slack_webhook", Configured: true, Expired: true, UpdatedAt: time.Now()},
		},
		Subworkflows: []SubworkflowCapability{{WorkflowID: "wf-child", Name: "Child", Status: "active", LatestVersion: 3}},
	}
}

func TestBindWorkflowRejectsInventedCapabilitiesWithoutRewriting(t *testing.T) {
	wf := &domain.Workflow{ID: "wf-parent", Nodes: []domain.Node{
		{ID: "fake-tool", Type: "tool", Config: map[string]any{"tool": "invented.send", "input": map[string]any{}}},
		{ID: "fake-mcp", Type: "mcp_tool", Config: map[string]any{"connectionAlias": "crm", "toolName": "contacts.delete"}},
		{ID: "fake-child", Type: "subworkflow", Config: map[string]any{"workflowId": "wf-invented"}},
	}, Edges: []domain.Edge{}}
	report := BindWorkflow(bindingTestCatalog(), wf)
	if report.Complete || len(report.Missing) != 3 {
		t.Fatalf("invented bindings must remain explicit: %+v", report)
	}
	if wf.Nodes[0].Config["tool"] != "invented.send" {
		t.Fatal("binder must not rewrite an invented identifier")
	}
	for _, missing := range report.Missing {
		if len(missing.Alternatives) == 0 {
			t.Fatalf("real alternatives should be visible: %+v", missing)
		}
	}
}

func TestBindWorkflowResolvesExactCatalogAndCompletePrimitives(t *testing.T) {
	wf := &domain.Workflow{ID: "wf-parent", Nodes: []domain.Node{
		{ID: "notify", Type: "tool", Config: map[string]any{"tool": "slack.post", "input": map[string]any{"credential": "incidents"}}},
		{ID: "mcp", Type: "mcp_tool", Config: map[string]any{
			"connectionAlias": "crm", "toolName": "contacts.update",
			"input": map[string]any{"contactId": "{{context.input.contactId}}"},
		}},
		{ID: "child", Type: "subworkflow", Config: map[string]any{"workflowId": "wf-child", "version": float64(3)}},
		{ID: "wait", Type: "wait_until", Config: map[string]any{"duration": "PT5M"}},
		{ID: "cron", Type: "schedule", Config: map[string]any{"cronExpression": "0 9 * * *"}},
		{ID: "crew", Type: "multi_agent", Config: map[string]any{"agents": []any{map[string]any{"goal": "Inspect evidence"}}}},
		{ID: "route", Type: "router_llm", Config: map[string]any{"candidates": []any{map[string]any{"nodeId": "fast"}, map[string]any{"nodeId": "safe"}}}},
		{ID: "fast", Type: "noop", Config: map[string]any{}},
		{ID: "safe", Type: "noop", Config: map[string]any{}},
	}, Edges: []domain.Edge{{From: "route", To: "fast"}, {From: "route", To: "safe"}}}
	report := BindWorkflow(bindingTestCatalog(), wf)
	if !report.Complete || len(report.Missing) != 0 {
		t.Fatalf("exact complete capabilities rejected: %+v", report)
	}
	if len(report.Resolved) != 4 { // tool + credential + MCP + subworkflow
		t.Fatalf("resolved bindings: %+v", report.Resolved)
	}
}

func TestBindWorkflowFlagsExpiredCredentialAndIncompleteSafeNodes(t *testing.T) {
	wf := &domain.Workflow{Nodes: []domain.Node{
		{ID: "notify", Type: "tool", Config: map[string]any{"tool": "slack.post", "input": map[string]any{"credential": "old"}}},
		{ID: "uppercase", Type: "tool", Config: map[string]any{"tool": "text.uppercase", "input": map[string]any{}}},
		{ID: "mcp", Type: "mcp_tool", Config: map[string]any{"connectionAlias": "crm", "toolName": "contacts.update"}},
		{ID: "wait", Type: "wait_until", Config: map[string]any{}},
		{ID: "cron", Type: "schedule", Config: map[string]any{"cronExpression": "not cron"}},
		{ID: "crew", Type: "multi_agent", Config: map[string]any{"agents": []any{}}},
		{ID: "route", Type: "router_llm", Config: map[string]any{"candidates": []any{}}},
	}, Edges: []domain.Edge{}}
	report := BindWorkflow(bindingTestCatalog(), wf)
	if report.Complete || len(report.Missing) != 7 {
		t.Fatalf("unsafe/incomplete nodes must block apply: %+v", report)
	}
}
