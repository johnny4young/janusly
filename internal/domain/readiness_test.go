package domain

import "testing"

// The three fork/join gate rules with their reference severities.

func readinessDoc(t *testing.T, doc string) *Workflow {
	t.Helper()
	wf, issues := Parse([]byte(doc))
	if wf == nil {
		t.Fatalf("fixture must parse: %+v", issues)
	}
	return wf
}

func findReadiness(issues []ReadinessIssue, code string) *ReadinessIssue {
	for i := range issues {
		if issues[i].Code == code {
			return &issues[i]
		}
	}
	return nil
}

func TestForkWithoutJoinIsAWarn(t *testing.T) {
	wf := readinessDoc(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a1","type":"noop","config":{}},
		{"id":"b1","type":"noop","config":{}}
	],"edges":[{"from":"fork","to":"a1"},{"from":"fork","to":"b1"}]}`)
	issue := findReadiness(CheckForkJoinReadiness(wf), "fork_without_join_pair")
	if issue == nil || issue.Severity != "warn" || issue.NodeID != "fork" {
		t.Fatalf("warn-level rule broken: %+v", issue)
	}
}

func TestJoinSourceOutsideAncestryFails(t *testing.T) {
	wf := readinessDoc(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a1","type":"noop","config":{}},
		{"id":"b1","type":"noop","config":{}},
		{"id":"stranger","type":"noop","config":{}},
		{"id":"merge","type":"join","config":{"sources":{"a":"a1","b":"stranger"}}}
	],"edges":[
		{"from":"fork","to":"a1"},{"from":"fork","to":"b1"},
		{"from":"a1","to":"merge"},{"from":"b1","to":"merge"}
	]}`)
	issues := CheckForkJoinReadiness(wf)
	unreachable := findReadiness(issues, "join_sources_unreachable")
	if unreachable == nil || unreachable.Severity != "fail" {
		t.Fatalf("unreachable source must fail: %+v", issues)
	}
}

func TestForkLabelsUncoveredByAnyJoinFails(t *testing.T) {
	wf := readinessDoc(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a1","type":"noop","config":{}},
		{"id":"b1","type":"noop","config":{}},
		{"id":"merge","type":"join","config":{"sources":{"a":"a1","other":"b1"}}}
	],"edges":[
		{"from":"fork","to":"a1"},{"from":"fork","to":"b1"},
		{"from":"a1","to":"merge"},{"from":"b1","to":"merge"}
	]}`)
	issue := findReadiness(CheckForkJoinReadiness(wf), "fork_join_missing_branch_sources")
	if issue == nil || issue.Severity != "fail" {
		t.Fatalf("uncovered labels must fail: %+v", issue)
	}
}

func TestWellPairedForkJoinIsClean(t *testing.T) {
	wf := readinessDoc(t, `{"nodes":[
		{"id":"fork","type":"parallel_fork","config":{"branches":[{"label":"a"},{"label":"b"}]}},
		{"id":"a1","type":"noop","config":{}},
		{"id":"b1","type":"noop","config":{}},
		{"id":"merge","type":"join","config":{"sources":{"a":"a1","b":"b1"}}}
	],"edges":[
		{"from":"fork","to":"a1"},{"from":"fork","to":"b1"},
		{"from":"a1","to":"merge"},{"from":"b1","to":"merge"}
	]}`)
	if issues := CheckForkJoinReadiness(wf); len(issues) != 0 {
		t.Fatalf("well-paired fork/join must be clean: %+v", issues)
	}
}

// mcp_tool is write-side BY DEFAULT (the workflow JSON only carries
// alias+tool; the real writeSide flag lives on the API-side descriptor
// table): without an approval ancestor the gate flags it, with one it
// stays quiet. False positives cost an ignorable suggestion; false
// negatives would miss a real external write.
func TestReadinessMcpToolApprovalGate(t *testing.T) {
	bare := &Workflow{
		ID: "wf", Name: "w", DSLVersion: "1.0",
		Nodes: []Node{{ID: "m", Type: "mcp_tool", Config: map[string]any{
			"connectionAlias": "crm", "toolName": "contacts.update",
		}}},
		Edges: []Edge{},
	}
	found := false
	for _, issue := range CheckWorkflowReadiness(bare, ReadinessOptions{}).Issues {
		if issue.Code == "sensitive_action_missing_approval" && issue.NodeID == "m" {
			found = true
		}
	}
	if !found {
		t.Fatal("mcp_tool without approval must flag as write-side by default")
	}

	gated := &Workflow{
		ID: "wf", Name: "w", DSLVersion: "1.0",
		Nodes: []Node{
			{ID: "a", Type: "approval", Config: map[string]any{}},
			{ID: "m", Type: "mcp_tool", Config: map[string]any{
				"connectionAlias": "crm", "toolName": "contacts.update",
			}},
		},
		Edges: []Edge{{From: "a", To: "m"}},
	}
	for _, issue := range CheckWorkflowReadiness(gated, ReadinessOptions{}).Issues {
		if issue.Code == "sensitive_action_missing_approval" && issue.NodeID == "m" {
			t.Fatal("approval ancestor must satisfy the gate")
		}
	}
}

func TestApprovalMustDominateEveryPathToSensitiveAction(t *testing.T) {
	wf := &Workflow{
		ID: "wf", Name: "w", DSLVersion: "1.0",
		Nodes: []Node{
			{ID: "approved_root", Type: "noop", Config: map[string]any{}},
			{ID: "approval", Type: "approval", Config: map[string]any{}},
			{ID: "bypass_root", Type: "noop", Config: map[string]any{}},
			{ID: "write", Type: "http", Config: map[string]any{"method": "POST"}},
		},
		Edges: []Edge{
			{From: "approved_root", To: "approval"},
			{From: "approval", To: "write"},
			{From: "bypass_root", To: "write"},
		},
	}
	if HasApprovalAncestorIn(wf, "write") {
		t.Fatal("an approval on only one incoming path must not authorize the bypass path")
	}
	issue := findReadiness(CheckWorkflowReadiness(wf, ReadinessOptions{}).Issues,
		"sensitive_action_missing_approval")
	if issue == nil || issue.NodeID != "write" {
		t.Fatalf("bypass path must retain the readiness warning: %+v", issue)
	}

	wf.Edges = append(wf.Edges[:2], Edge{From: "bypass_root", To: "approval"})
	if !HasApprovalAncestorIn(wf, "write") {
		t.Fatal("one unavoidable approval must dominate every path into the write")
	}
}

func TestAgentWriteOptInRequiresDominatingApproval(t *testing.T) {
	bare := &Workflow{
		ID: "wf", Name: "w", DSLVersion: "1.0",
		Nodes: []Node{{
			ID: "agent", Type: "agent",
			Config: map[string]any{"allowWriteTools": true},
		}},
	}
	issue := findReadiness(CheckWorkflowReadiness(bare, ReadinessOptions{}).Issues,
		"sensitive_action_missing_approval")
	if issue == nil || issue.NodeID != "agent" {
		t.Fatalf("write-enabled agent without approval must be visible: %+v", issue)
	}

	readOnly := &Workflow{
		ID: "wf", Name: "w", DSLVersion: "1.0",
		Nodes: []Node{{ID: "agent", Type: "agent", Config: map[string]any{}}},
	}
	if issue := findReadiness(CheckWorkflowReadiness(readOnly, ReadinessOptions{}).Issues,
		"sensitive_action_missing_approval"); issue != nil {
		t.Fatalf("read-only agent must not claim write authority: %+v", issue)
	}
}

func TestSuggestionSafetyUsesRegistryWriteMetadata(t *testing.T) {
	wf := &Workflow{
		ID: "wf", Name: "w", DSLVersion: "1.0",
		Nodes: []Node{{
			ID: "mutate", Type: "tool",
			Config: map[string]any{"tool": "future.arbitrary", "input": map[string]any{}},
		}},
	}
	safety := ComputeSuggestionSafetyWithOptions(wf, "mutate", ReadinessOptions{
		IsWriteSideTool: func(tool string, _ map[string]any) bool {
			return tool == "future.arbitrary"
		},
	})
	if !safety.WriteSide || !safety.ApprovalRequired || safety.ApprovalPresent {
		t.Fatalf("registry write metadata must govern recovery safety: %+v", safety)
	}
}
