package mcpserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/store"
)

func TestParsePermissionCeilingDefaultsReadOnlyAndRejectsUnknown(t *testing.T) {
	permissions, err := ParsePermissionCeiling("")
	if err != nil {
		t.Fatal(err)
	}
	for _, permission := range []string{"workflows.read", "runs.read", "dlq.read", "recovery.read"} {
		if !permissions[permission] {
			t.Fatalf("default permission missing: %s", permission)
		}
	}
	for _, forbidden := range []string{"workflows.write", "runs.start", "recovery.write", "ai.write"} {
		if permissions[forbidden] {
			t.Fatalf("default ceiling unexpectedly grants %s", forbidden)
		}
	}
	if _, err := ParsePermissionCeiling("runs.read,made.up"); err == nil {
		t.Fatal("unknown permission must fail startup")
	}
}

func TestOperatorBriefGuardAcceptsAnyContributingReadScope(t *testing.T) {
	for _, permission := range []string{"recovery.read", "runs.read", "dlq.read"} {
		deps := Deps{
			OrgID: "org-1", UserID: "operator-1",
			Permissions: map[string]bool{permission: true},
		}
		allowed, message := deps.guardToolAny(context.Background(), "operations.brief", []string{
			"recovery.read", "runs.read", "dlq.read",
		}, false)
		if !allowed || message != "" {
			t.Fatalf("%s should admit its bounded projection: allowed=%v message=%q", permission, allowed, message)
		}
	}

	deps := Deps{
		OrgID: "org-1", UserID: "operator-1",
		Permissions: map[string]bool{"workflows.read": true},
	}
	allowed, message := deps.guardToolAny(context.Background(), "operations.brief", []string{
		"recovery.read", "runs.read", "dlq.read",
	}, false)
	if allowed || !strings.Contains(message, "dlq.read, recovery.read, runs.read") {
		t.Fatalf("unrelated read scope should fail closed: allowed=%v message=%q", allowed, message)
	}
}

func TestMCPToolCatalogHasTruthfulAnnotationsAndNoApprovalTool(t *testing.T) {
	server := NewServer(Deps{})
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		_ = server.Run(context.Background(), serverTransport)
	}()
	client := mcp.NewClient(&mcp.Implementation{Name: "catalog-test", Version: "1"}, nil)
	session, err := client.Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close(); <-serverDone })
	listed, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Tools) != 15 {
		t.Fatalf("tool catalog drifted: got %d", len(listed.Tools))
	}
	byName := map[string]*mcp.Tool{}
	for _, tool := range listed.Tools {
		byName[tool.Name] = tool
		if tool.Annotations == nil || tool.Annotations.OpenWorldHint == nil || *tool.Annotations.OpenWorldHint {
			t.Fatalf("tool lacks closed-world annotations: %+v", tool)
		}
	}
	if byName["recovery.cases.approve"] != nil {
		t.Fatal("MCP must never expose human approval")
	}
	for _, name := range []string{"operations.brief", "workflows.propose", "recovery.cases.inspect"} {
		if tool := byName[name]; tool == nil || !tool.Annotations.ReadOnlyHint {
			t.Fatalf("read tool annotation drifted: %s %+v", name, tool)
		}
	}
	for _, name := range []string{"recovery.cases.diagnose", "recovery.cases.validate", "recovery.cases.apply"} {
		if tool := byName[name]; tool == nil || tool.Annotations.ReadOnlyHint {
			t.Fatalf("write tool annotation drifted: %s %+v", name, tool)
		}
	}
	if tool := byName["recovery.cases.apply"]; tool.Annotations.DestructiveHint == nil || !*tool.Annotations.DestructiveHint {
		t.Fatal("recovery apply must be marked destructive")
	}
}

func TestMCPProposalProjectionRejectsInventedCapabilityAndWithholdsConfig(t *testing.T) {
	document := map[string]any{
		"id": "wf-proposal", "name": "Secret sk-abcdefghijklmnopqrstuv",
		"nodes": []any{map[string]any{
			"id": "send", "type": "tool",
			"config": map[string]any{"tool": "invented.send", "token": "clear"},
		}},
		"edges": []any{},
	}
	catalog := authoring.Catalog{SchemaVersion: "1", Version: "catalog-v1"}
	bindings, workflow, issues := authoring.BindWorkflowJSON(catalog, document)
	compiled, err := authoring.CompileBrief(authoring.CompileBriefRequest{Prompt: "Send an incident alert"})
	if err != nil {
		t.Fatal(err)
	}
	view := mcpWorkflowProposalView(compiled, catalog, bindings, workflow, issues, "caller_draft")
	raw, _ := json.Marshal(view)
	text := string(raw)
	if view["applicable"] != false || !strings.Contains(text, "exact_tool_not_found") {
		t.Fatalf("invented capability must remain explicit: %s", text)
	}
	for _, forbidden := range []string{`"config"`, `"token"`, "clear", "sk-abcdefghijklmnopqrstuv"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("proposal projection leaked %q: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, "[redacted]") {
		t.Fatalf("secret-shaped workflow name should be scrubbed: %s", text)
	}
}

func TestMCPRecoveryArtifactProjectionWithholdsOutputReasonAndEvidence(t *testing.T) {
	payload := engine.SemanticRecoveryCandidatePayload{
		Kind: "replace_output", Decision: "replace",
		Output: map[string]any{"token": "never-return"},
		Reason: "sensitive operator rationale", Risk: "medium",
		Evidence:            []domain.RecoveryCaseEvidenceRef{{Kind: "run", ID: "run-secret"}},
		ExpectedResult:      "Recover without sk-abcdefghijklmnopqrstuv",
		RequiredPermissions: []string{"recovery.write"},
	}
	raw, _ := json.Marshal(payload)
	view := mcpRecoveryArtifactView(store.RecoveryCaseArtifact{
		ID: "candidate-1", Kind: "candidate", PayloadJson: raw,
		PayloadSha256: strings.Repeat("a", 64), ActorKind: "user", CreatedAt: time.Now(),
	})
	wire, _ := json.Marshal(view)
	text := string(wire)
	for _, forbidden := range []string{"never-return", "sensitive operator rationale", "run-secret", "sk-abcdefghijklmnopqrstuv"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("candidate projection leaked %q: %s", forbidden, text)
		}
	}
	if !strings.Contains(text, `"outputWithheld":true`) || !strings.Contains(text, "[redacted]") {
		t.Fatalf("bounded candidate metadata missing: %s", text)
	}
}

func TestSafeErrorProjectionWhitelistsAndScrubs(t *testing.T) {
	view := safeErrorProjection(json.RawMessage(`{
		"code":"UPSTREAM","message":"failed with sk-abcdefghijklmnopqrstuv",
		"details":{"private":"must-not-return"},"authorization":"Bearer clear"
	}`))
	raw, _ := json.Marshal(view)
	text := string(raw)
	if !strings.Contains(text, "UPSTREAM") || !strings.Contains(text, "[redacted]") {
		t.Fatalf("classification should survive redacted: %s", text)
	}
	for _, forbidden := range []string{"must-not-return", "Bearer clear", "details", "authorization", "sk-abcdefghijklmnopqrstuv"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("error projection leaked %q: %s", forbidden, text)
		}
	}
}

func TestMCPResponseAndExpectedErrorsAreGloballyBounded(t *testing.T) {
	result, structured, err := ok(map[string]any{"payload": strings.Repeat("x", maxMCPResponseBytes)})
	if err != nil || result == nil || !result.IsError || structured != nil {
		t.Fatalf("oversized response must fail as a bounded expected result: result=%+v structured=%+v err=%v",
			result, structured, err)
	}
	if text := result.Content[0].(*mcp.TextContent).Text; len(text) > maxMCPErrorSummaryRunes {
		t.Fatalf("bounded response error is too large: %d", len(text))
	}

	result, _, err = expected(strings.Repeat("secret sk-abcdefghijklmnopqrstuv ", 100))
	if err != nil || result == nil || !result.IsError {
		t.Fatalf("expected error failed: result=%+v err=%v", result, err)
	}
	text := result.Content[0].(*mcp.TextContent).Text
	if len([]rune(text)) > maxMCPErrorSummaryRunes || strings.Contains(text, "sk-abcdefghijklmnopqrstuv") {
		t.Fatalf("expected error was not bounded and scrubbed: %q", text)
	}
}

func TestMCPRawToolRequestsAreBoundedBeforeTypedDispatch(t *testing.T) {
	server := NewServer(Deps{
		OrgID: "org-1", UserID: "operator-1",
		Permissions: map[string]bool{"runs.read": true},
	})
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		_ = server.Run(context.Background(), serverTransport)
	}()
	client := mcp.NewClient(&mcp.Implementation{Name: "request-bound-test", Version: "1"}, nil)
	session, err := client.Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close(); <-serverDone })

	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name: "runs.status",
		Arguments: map[string]any{
			"runId": strings.Repeat("x", maxMCPRequestBytes),
		},
	})
	if err != nil {
		t.Fatalf("oversized request became a transport failure: %v", err)
	}
	if result == nil || !result.IsError || len(result.Content) != 1 {
		t.Fatalf("oversized request must be a bounded expected failure: %+v", result)
	}
	message := result.Content[0].(*mcp.TextContent).Text
	if message != "MCP tool request is invalid or exceeds 256000 bytes" {
		t.Fatalf("unexpected request-bound response: %q", message)
	}
}

func TestMCPScalarArgumentBounds(t *testing.T) {
	if !validMCPIdentifier(strings.Repeat("é", maxMCPIdentifierRunes)) ||
		validMCPIdentifier("") || validMCPIdentifier(strings.Repeat("é", maxMCPIdentifierRunes+1)) {
		t.Fatal("identifier bounds drifted")
	}
	if !validOptionalMCPIdentifier("") || !validOptionalMCPIdentifier("workflow") ||
		validOptionalMCPIdentifier(strings.Repeat("x", maxMCPIdentifierRunes+1)) {
		t.Fatal("optional identifier bounds drifted")
	}
	if !validOptionalMCPCursor("") || !validOptionalMCPCursor(strings.Repeat("x", maxMCPCursorRunes)) ||
		validOptionalMCPCursor(strings.Repeat("x", maxMCPCursorRunes+1)) {
		t.Fatal("cursor bounds drifted")
	}
}
