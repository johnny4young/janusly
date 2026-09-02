package domain

import (
	"strings"
	"testing"
)

func gateWorkflow(t *testing.T, doc string) *Workflow {
	t.Helper()
	wf, issues := Parse([]byte(doc))
	if wf == nil {
		t.Fatalf("fixture must parse: %+v", issues)
	}
	return wf
}

func issueByCode(result ReadinessResult, code string) *ReadinessIssue {
	for i := range result.Issues {
		if result.Issues[i].Code == code {
			return &result.Issues[i]
		}
	}
	return nil
}

// Each case cites the contract rule it ports (workflow-readiness.ts).
func TestReadinessRules(t *testing.T) {
	writeSide := func(tool string, _ map[string]any) bool { return tool == "fake.write" }
	external := func(tool string) bool { return tool == "fake.read" || tool == "fake.write" }
	opts := ReadinessOptions{IsWriteSideTool: writeSide, IsExternalTool: external}

	cases := []struct {
		name       string
		doc        string
		wantCode   string
		severity   string
		absentCode string
	}{
		{
			name: "http without bounds warns", // checkHttpBounds
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"call","type":"http",
				"config":{"url":"https://x.test","retry":{"maxAttempts":3}}}],"edges":[]}`,
			wantCode: "http_missing_bounds", severity: "warn",
		},
		{
			name: "one bound silences the warn", // hasAnyBound
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"call","type":"http",
				"config":{"url":"https://x.test","timeoutMs":5000,"retry":{"maxAttempts":3}}}],"edges":[]}`,
			absentCode: "http_missing_bounds",
		},
		{
			name: "read-side http without retry fails", // checkExternalRetry
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"call","type":"http",
				"config":{"url":"https://x.test","timeoutMs":5000}}],"edges":[]}`,
			wantCode: "external_node_missing_retry", severity: "fail",
		},
		{
			name: "write-side http skips the retry requirement", // retrySafe
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"post","type":"http",
				"config":{"url":"https://x.test","method":"POST","timeoutMs":1}}],"edges":[]}`,
			absentCode: "external_node_missing_retry",
		},
		{
			name: "local tool without retry stays local",
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"clock","type":"tool",
				"config":{"tool":"fake.local","input":{}}}],"edges":[]}`,
			absentCode: "external_node_missing_retry",
		},
		{
			name: "external read tool without retry fails",
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"read","type":"tool",
				"config":{"tool":"fake.read","input":{}}}],"edges":[]}`,
			wantCode: "external_node_missing_retry", severity: "fail",
		},
		{
			name: "write-side tool without result policy fails", // checkToolResultPolicy
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"send","type":"tool",
				"config":{"tool":"fake.write","input":{}}}],"edges":[]}`,
			wantCode: "tool_result_policy_missing", severity: "fail",
		},
		{
			name: "require_ok satisfies the policy",
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"send","type":"tool",
				"config":{"tool":"fake.write","input":{},"resultPolicy":"require_ok"}}],"edges":[]}`,
			absentCode: "tool_result_policy_missing",
		},
		{
			name: "hardcoded secret-shaped value fails", // checkRawSecretsInConfig
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"call","type":"http",
				"config":{"url":"https://x.test","timeoutMs":1,"retry":{"maxAttempts":2},
				"headers":{"authorization":"Bearer sk-live-1234"}}}],"edges":[]}`,
			wantCode: "raw_secret_in_config", severity: "fail",
		},
		{
			name: "secret template reference is fine", // SECRET_TEMPLATE_PATTERN
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"call","type":"http",
				"config":{"url":"https://x.test","timeoutMs":1,"retry":{"maxAttempts":2},
				"headers":{"authorization":"{{secret.API_TOKEN}}"}}}],"edges":[]}`,
			absentCode: "raw_secret_in_config",
		},
		{
			name: "sensitive method without approval ancestor warns", // checkSensitiveAction
			doc: `{"outputs":{"r":"x"},"nodes":[{"id":"post","type":"http",
				"config":{"url":"https://x.test","method":"DELETE","timeoutMs":1}}],"edges":[]}`,
			wantCode: "sensitive_action_missing_approval", severity: "warn",
		},
		{
			name: "approval ancestor silences the warn", // hasApprovalAncestor
			doc: `{"outputs":{"r":"x"},"nodes":[
				{"id":"gate","type":"approval","config":{}},
				{"id":"post","type":"http","config":{"url":"https://x.test","method":"DELETE","timeoutMs":1}}],
				"edges":[{"from":"gate","to":"post"}]}`,
			absentCode: "sensitive_action_missing_approval",
		},
		{
			name:     "missing outputs projection warns", // hasDeclaredOutputs
			doc:      `{"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[]}`,
			wantCode: "workflow_missing_outputs", severity: "warn",
		},
	}

	for _, tc := range cases {
		result := CheckWorkflowReadiness(gateWorkflow(t, tc.doc), opts)
		if tc.wantCode != "" {
			issue := issueByCode(result, tc.wantCode)
			if issue == nil || issue.Severity != tc.severity {
				t.Fatalf("%s: want %s/%s, got %+v", tc.name, tc.wantCode, tc.severity, result.Issues)
			}
		}
		if tc.absentCode != "" {
			if issue := issueByCode(result, tc.absentCode); issue != nil {
				t.Fatalf("%s: %s must be absent, got %+v", tc.name, tc.absentCode, issue)
			}
		}
	}
}

func TestReadinessRollupAndMessages(t *testing.T) {
	// A clean workflow reaches pass — the badge's green state is reachable.
	clean := gateWorkflow(t, `{"outputs":{"r":"{{context.a.output}}"},
		"nodes":[{"id":"a","type":"noop","config":{}}],"edges":[]}`)
	if got := CheckWorkflowReadiness(clean, ReadinessOptions{}); got.Status != "pass" || len(got.Issues) != 0 {
		t.Fatalf("clean workflow: %+v", got)
	}

	// Eval-coverage warn is opt-in and downgrades pass → warn only.
	if got := CheckWorkflowReadiness(clean, ReadinessOptions{RequireEvalCoverage: true}); got.Status != "warn" {
		t.Fatalf("eval warn rollup: %+v", got)
	}

	// fail dominates warn; message text is the contract's, verbatim.
	failing := gateWorkflow(t, `{"nodes":[{"id":"call","type":"http",
		"config":{"url":"https://x.test"}}],"edges":[]}`)
	got := CheckWorkflowReadiness(failing, ReadinessOptions{})
	if got.Status != "fail" {
		t.Fatalf("rollup: %+v", got)
	}
	retry := issueByCode(got, "external_node_missing_retry")
	want := `Read-side node "call" makes an external call but has no retry policy. Transient failures will mark the run failed instead of being retried.`
	if retry == nil || retry.Message != want {
		t.Fatalf("verbatim message drifted: %+v", retry)
	}
	if !strings.Contains(retry.Suggestion, "production-grade is typically 3–5") {
		t.Fatalf("suggestion drifted: %+v", retry)
	}
}
