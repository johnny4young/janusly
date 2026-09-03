package authoring

import (
	"bytes"
	"encoding/json"
	"slices"
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
			{Name: "time.now"},
			{Name: "slack.post", Required: []string{"credential"}, WriteSide: true},
			{Name: "pagerduty.incident.get", Required: []string{"credential", "requesterEmail", "incidentId"}},
			{Name: "pagerduty.incident.acknowledge", Required: []string{"credential", "requesterEmail", "incidentId"}, WriteSide: true},
			{Name: "pagerduty.incident.snooze", Required: []string{"credential", "requesterEmail", "incidentId", "durationSeconds"}, WriteSide: true},
			{Name: "pagerduty.policy.evaluate", Required: []string{"eventType", "occurredAt", "receivedAt", "evaluatedAt", "incident", "pagerDutyUserId", "snoozeSeconds", "timeZone", "workingHours"}},
			{Name: "pagerduty.outcome.verify", Required: []string{"incident", "expectedIncidentId", "expectedSnoozeUntil"}},
			{Name: "vector.upsert", Required: []string{"content"}, WriteSide: true},
		},
		McpTools: []mcpclient.ExposedMcpTool{{
			ConnectionAlias: "crm", ToolName: "contacts.update",
			WriteSide:   true,
			InputFields: []mcpclient.ExposedMcpInputField{{Name: "contactId", Type: "string", Required: true}},
		}},
		Credentials: []CredentialCapability{
			{ID: "cred-1", Name: "incidents", Kind: "slack_webhook", Configured: true, UpdatedAt: time.Now()},
			{ID: "cred-expired", Name: "old", Kind: "slack_webhook", Configured: true, Expired: true, UpdatedAt: time.Now()},
			{ID: "cred-pd-api", Name: "pagerduty-api", Kind: "pagerduty_api_token", Configured: true, UpdatedAt: time.Now()},
			{ID: "cred-pd-hook", Name: "pagerduty-webhook", Kind: "pagerduty_webhook_secret", Configured: true, UpdatedAt: time.Now()},
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
	reasons := make([]string, 0, len(report.Missing))
	for _, missing := range report.Missing {
		if missing.Alternatives == nil {
			t.Fatalf("binding alternatives must be an empty JSON array, never null: %+v", missing)
		}
		reasons = append(reasons, missing.Reason)
	}
	for _, expected := range []string{"credential_expired", "tool_input_required", "mcp_input_required"} {
		if !slices.Contains(reasons, expected) {
			t.Fatalf("missing precise reason %q: %+v", expected, report.Missing)
		}
	}
	if HasUnboundCapabilityIdentity(report) {
		t.Fatalf("expired credentials and incomplete fields are not invented identities: %+v", report.Missing)
	}
}

func TestBindingReportsNeverMarshalNullCollections(t *testing.T) {
	t.Parallel()
	catalog := bindingTestCatalog()
	report, workflow, _ := BindWorkflowJSON(catalog, map[string]any{
		"nodes": []any{map[string]any{
			"id": "uppercase", "type": "tool",
			"config": map[string]any{"tool": "text.uppercase", "input": map[string]any{}},
		}},
		"edges": []any{},
	})
	if workflow == nil || report.Complete {
		t.Fatalf("expected a parseable, explicitly incomplete workflow: workflow=%+v report=%+v", workflow, report)
	}
	report = BindProposal(catalog, IntentBrief{
		Trigger: "unsupported-trigger", ExternalEffects: []string{"unknown-effect"},
	}, workflow)
	wire, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if len(wire) == 0 || slices.ContainsFunc(report.Missing, func(binding Binding) bool {
		return binding.Alternatives == nil
	}) {
		t.Fatalf("binding report contains a nil alternatives collection: %s", wire)
	}
	if bytes.Contains(wire, []byte(`"alternatives":null`)) {
		t.Fatalf("binding report emitted alternatives:null: %s", wire)
	}

	invalid, _, _ := BindWorkflowJSON(catalog, map[string]any{"nodes": "invalid", "edges": []any{}})
	invalidWire, err := json.Marshal(invalid)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(invalidWire, []byte(`"alternatives":null`)) {
		t.Fatalf("invalid workflow report emitted alternatives:null: %s", invalidWire)
	}
}

func TestBindWorkflowRejectsMalformedWaitAndSubworkflowVersion(t *testing.T) {
	wf := &domain.Workflow{ID: "wf-parent", Nodes: []domain.Node{
		{ID: "wait", Type: "wait_until", Config: map[string]any{"duration": "Pjunk"}},
		{ID: "child", Type: "subworkflow", Config: map[string]any{"workflowId": "wf-child", "version": "3"}},
	}, Edges: []domain.Edge{}}
	report := BindWorkflow(bindingTestCatalog(), wf)
	if report.Complete || len(report.Missing) != 2 || len(report.Resolved) != 0 {
		t.Fatalf("malformed executable config must block proposal apply: %+v", report)
	}
	reasons := []string{report.Missing[0].Reason, report.Missing[1].Reason}
	if !slices.Contains(reasons, "wait_until_configuration_incomplete") ||
		!slices.Contains(reasons, "subworkflow_version_invalid") {
		t.Fatalf("missing precise binding reasons: %+v", report.Missing)
	}
	if HasUnboundCapabilityIdentity(report) {
		t.Fatalf("malformed configuration is incomplete, not an invented catalog identity: %+v", report.Missing)
	}
}

func TestHasUnboundCapabilityIdentitySeparatesMissingConfigFromInventedIDs(t *testing.T) {
	identityReasons := []string{
		"exact_tool_not_found", "exact_mcp_tool_not_found", "exact_credential_not_found",
		"exact_subworkflow_not_eligible", "subworkflow_version_not_found", "node_type_not_executable",
	}
	for _, reason := range identityReasons {
		t.Run("identity/"+reason, func(t *testing.T) {
			if !HasUnboundCapabilityIdentity(BindingReport{Missing: []Binding{{Reason: reason}}}) {
				t.Fatalf("%s must activate the provider identity guard", reason)
			}
		})
	}
	configurationReasons := []string{
		"tool_binding_required", "mcp_binding_required", "credential_binding_required",
		"credential_not_configured", "credential_expired", "subworkflow_binding_required",
		"subworkflow_version_invalid", "tool_input_required", "mcp_input_required",
		"wait_until_configuration_incomplete",
	}
	for _, reason := range configurationReasons {
		t.Run("configuration/"+reason, func(t *testing.T) {
			if HasUnboundCapabilityIdentity(BindingReport{Missing: []Binding{{Reason: reason}}}) {
				t.Fatalf("%s must remain a reviewable incomplete configuration", reason)
			}
		})
	}
}

func TestBindWorkflowClassifiesUnknownCredentialAsIdentity(t *testing.T) {
	wf := &domain.Workflow{Nodes: []domain.Node{{
		ID: "notify", Type: "tool", Config: map[string]any{
			"tool": "slack.post", "input": map[string]any{"credential": "invented-credential"},
		},
	}}}
	report := BindWorkflow(bindingTestCatalog(), wf)
	if !HasUnboundCapabilityIdentity(report) || len(report.Missing) != 1 || report.Missing[0].Reason != "exact_credential_not_found" {
		t.Fatalf("unknown credential must be an exact identity failure: %+v", report)
	}
}

func TestBindWorkflowResolvesPagerDutyTriggerAndRejectsWrongCredentialKinds(t *testing.T) {
	catalog := bindingTestCatalog()
	workflow := &domain.Workflow{Nodes: []domain.Node{
		{ID: "trigger", Type: "pagerduty_incident", Config: map[string]any{"webhookCredential": "pagerduty-webhook"}},
		{ID: "read", Type: "tool", Config: map[string]any{"tool": "pagerduty.incident.get", "input": map[string]any{
			"credential": "pagerduty-api", "requesterEmail": "operator@example.com", "incidentId": "P1",
		}}},
	}}
	report := BindWorkflow(catalog, workflow)
	if !report.Complete || len(report.Missing) != 0 || len(report.Resolved) != 3 {
		t.Fatalf("exact PagerDuty bindings rejected: %+v", report)
	}

	workflow.Nodes[0].Config["webhookCredential"] = "pagerduty-api"
	workflow.Nodes[1].Config["input"].(map[string]any)["credential"] = "pagerduty-webhook"
	report = BindWorkflow(catalog, workflow)
	if report.Complete || len(report.Missing) != 2 {
		t.Fatalf("wrong credential kinds must block Apply: %+v", report)
	}
	for _, missing := range report.Missing {
		if missing.Reason != "credential_kind_mismatch" {
			t.Fatalf("wrong reason: %+v", report.Missing)
		}
		if len(missing.Alternatives) != 1 {
			t.Fatalf("only credentials of the required kind may be alternatives: %+v", missing)
		}
	}
}

func TestBindWorkflowHandlesNilAndNeverSuggestsWrongCredentialKind(t *testing.T) {
	catalog := bindingTestCatalog()
	report := BindWorkflow(catalog, nil)
	if report.Complete || len(report.Missing) != 1 || report.Missing[0].Reason != "workflow_contract_invalid" {
		t.Fatalf("nil workflow must fail closed without panicking: %+v", report)
	}

	catalog.Credentials = []CredentialCapability{{
		ID: "cred-slack", Name: "slack-only", Kind: "slack_webhook", Configured: true,
	}}
	workflow := &domain.Workflow{Nodes: []domain.Node{{
		ID: "read", Type: "tool", Config: map[string]any{
			"tool": "pagerduty.incident.get", "input": map[string]any{
				"credential": "", "requesterEmail": "operator@example.com", "incidentId": "P1",
			},
		},
	}}}
	report = BindWorkflow(catalog, workflow)
	if report.Complete || len(report.Missing) != 1 || len(report.Missing[0].Alternatives) != 0 {
		t.Fatalf("an incompatible credential must never be suggested as a valid alternative: %+v", report)
	}
}

func TestBindWorkflowTraversesEveryNestedToolLocation(t *testing.T) {
	catalog := bindingTestCatalog()
	invented := &domain.Workflow{Nodes: []domain.Node{
		{ID: "batch", Type: "loop", Config: map[string]any{
			"mode": "for_each", "tool": "invented.batch", "items": []any{"x"}, "input": map[string]any{},
		}},
		{ID: "agent", Type: "agent", Config: map[string]any{
			"goal": "Inspect", "tool": "invented.agent", "input": map[string]any{},
		}},
		{ID: "crew", Type: "multi_agent", Config: map[string]any{
			"agents": []any{map[string]any{"goal": "Inspect", "tool": "invented.member", "input": map[string]any{}}},
		}},
	}}
	report := BindWorkflow(catalog, invented)
	if report.Complete || !HasUnboundCapabilityIdentity(report) {
		t.Fatalf("nested invented tools must fail exact binding: %+v", report)
	}
	for _, field := range []string{"config.tool", "config.agents[0].tool"} {
		found := false
		for _, missing := range report.Missing {
			found = found || (missing.Field == field && missing.Reason == "exact_tool_not_found")
		}
		if !found {
			t.Fatalf("missing nested identity at %s: %+v", field, report.Missing)
		}
	}

	valid := &domain.Workflow{Nodes: []domain.Node{
		{ID: "batch", Type: "loop", Config: map[string]any{
			"mode": "for_each", "tool": "text.uppercase", "items": []any{"x"},
			"input": map[string]any{"value": "{{item}}"},
		}},
		{ID: "agent", Type: "agent", Config: map[string]any{
			"goal": "Notify", "tool": "slack.post", "allowWriteTools": true,
			"input": map[string]any{"credential": "incidents", "text": "Ready"},
		}},
		{ID: "crew", Type: "multi_agent", Config: map[string]any{
			"agents": []any{map[string]any{
				"goal": "Normalize", "tool": "text.uppercase", "input": map[string]any{"value": "ready"},
			}},
		}},
	}}
	report = BindWorkflow(catalog, valid)
	if !report.Complete || len(report.Missing) != 0 || len(report.Resolved) != 4 {
		t.Fatalf("valid nested bindings rejected: %+v", report)
	}
}

func TestBindWorkflowRequiresNodeLevelAgentWriteOptIn(t *testing.T) {
	for name, node := range map[string]domain.Node{
		"agent": {ID: "agent", Type: "agent", Config: map[string]any{
			"goal": "Remember", "tool": "vector.upsert", "input": map[string]any{"content": "fact"},
		}},
		"multi_agent": {ID: "crew", Type: "multi_agent", Config: map[string]any{
			"agents": []any{map[string]any{
				"goal": "Remember", "tool": "vector.upsert", "input": map[string]any{"content": "fact"},
			}},
		}},
	} {
		t.Run(name, func(t *testing.T) {
			report := BindWorkflow(bindingTestCatalog(), &domain.Workflow{Nodes: []domain.Node{node}})
			if report.Complete || HasUnboundCapabilityIdentity(report) ||
				!bindingReasonRequested(report, "agent_write_opt_in_required", "") {
				t.Fatalf("agent write opt-in must be explicit and non-identity: %+v", report)
			}
		})
	}
}
