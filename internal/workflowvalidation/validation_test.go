package workflowvalidation

import (
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

func parseWorkflow(t *testing.T, raw string) *domain.Workflow {
	t.Helper()
	workflow, issues := domain.Parse([]byte(raw))
	if workflow == nil || len(issues) > 0 {
		t.Fatalf("parse workflow: %+v", issues)
	}
	return workflow
}

func hasIssue(result domain.ValidationResult, code string) bool {
	for _, issue := range result.Issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}

func TestValidateUsesExactExecutableToolRegistry(t *testing.T) {
	unknown := Validate(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"invented.call","input":{}}}],"edges":[]}`))
	if !hasIssue(unknown, domain.CodeToolInvalidInput) {
		t.Fatalf("unknown tool was accepted: %+v", unknown.Issues)
	}

	missing := Validate(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"text.uppercase","input":{}}}],"edges":[]}`))
	if !hasIssue(missing, domain.CodeToolInvalidInput) {
		t.Fatalf("missing required tool input was accepted: %+v", missing.Issues)
	}
	if draft := ValidateDraft(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"text.uppercase","input":{}}}],"edges":[]}`)); !draft.Valid {
		t.Fatalf("draft posture should allow incomplete known-tool input: %+v", draft.Issues)
	}
	wrongDraft := ValidateDraft(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"text.uppercase","input":{"value":42}}}],"edges":[]}`))
	if !hasIssue(wrongDraft, domain.CodeToolInvalidInput) {
		t.Fatalf("draft posture accepted a supplied wrong-typed input: %+v", wrongDraft.Issues)
	}
	templatedObject := Validate(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"json.pick","input":{"path":"id","source":"{{context.load.output.payload}}"}}}],"edges":[]}`))
	if !templatedObject.Valid {
		t.Fatalf("whole native template reference should satisfy a typed input until render: %+v", templatedObject.Issues)
	}

	validInputs := map[string]string{
		"text.uppercase": `{"value":"x"}`,
		"csv.fetch":      `{"url":"https://example.com/data.csv"}`,
		"http.request":   `{"url":"https://example.com"}`,
	}
	for tool, input := range validInputs {
		result := Validate(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"`+tool+`","input":`+input+`}}],"edges":[]}`))
		if !result.Valid {
			t.Fatalf("executable tool %s rejected: %+v", tool, result.Issues)
		}
	}

	unknownField := Validate(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"text.uppercase","input":{"value":"x","url":"https://example.com"}}}],"edges":[]}`))
	if !hasIssue(unknownField, domain.CodeToolInvalidInput) {
		t.Fatalf("invented tool input field was accepted: %+v", unknownField.Issues)
	}
}

func TestValidateUsesDefinitionSpecificToolSemantics(t *testing.T) {
	for _, raw := range []string{
		`{"nodes":[{"id":"call","type":"tool","config":{"tool":"http.request","input":{"url":"https://example.com","maxRedirects":21}}}],"edges":[]}`,
		`{"nodes":[{"id":"call","type":"tool","config":{"tool":"http.request","input":{"url":"https://example.com","headers":{"X-Count":2}}}}],"edges":[]}`,
		`{"nodes":[{"id":"call","type":"tool","config":{"tool":"csv.fetch","input":{"url":"https://example.com/data.csv","sampleRows":501}}}],"edges":[]}`,
	} {
		result := Validate(parseWorkflow(t, raw))
		if !hasIssue(result, domain.CodeToolInvalidInput) {
			t.Fatalf("semantically invalid tool input was accepted: %+v", result.Issues)
		}
	}

	// A draft can omit the required URL, but a supplied option is not allowed
	// to exceed the executable contract merely because another binding is
	// incomplete.
	draft := ValidateDraft(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"http.request","input":{"timeoutMs":600001}}}],"edges":[]}`))
	if !hasIssue(draft, domain.CodeToolInvalidInput) {
		t.Fatalf("partial draft hid invalid supplied HTTP bound: %+v", draft.Issues)
	}

	templated := Validate(parseWorkflow(t, `{"nodes":[{"id":"call","type":"tool","config":{"tool":"http.request","input":{"url":"{{context.input.url}}","timeoutMs":"{{context.policy.output.timeoutMs}}"}}}],"edges":[]}`))
	if !templated.Valid {
		t.Fatalf("whole references should defer semantic values until render: %+v", templated.Issues)
	}
}

func TestValidateRejectsUnknownForEachTool(t *testing.T) {
	result := Validate(parseWorkflow(t, `{"nodes":[{"id":"each","type":"loop","config":{"items":[1],"mode":"for_each","tool":"invented.call"}}],"edges":[]}`))
	if !hasIssue(result, domain.CodeLoopForEachUnknownTool) {
		t.Fatalf("unknown loop tool was accepted: %+v", result.Issues)
	}
}

func TestValidateRejectsInvalidAgentAndCrewTools(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		code string
	}{
		{
			name: "unknown agent tool",
			raw:  `{"nodes":[{"id":"agent","type":"agent","config":{"goal":"inspect","tool":"invented.call","input":{}}}],"edges":[]}`,
			code: domain.CodeAgentInvalidTool,
		},
		{
			name: "missing agent tool input",
			raw:  `{"nodes":[{"id":"agent","type":"agent","config":{"goal":"uppercase","tool":"text.uppercase","input":{}}}],"edges":[]}`,
			code: domain.CodeAgentInvalidTool,
		},
		{
			name: "unknown crew tool",
			raw:  `{"nodes":[{"id":"crew","type":"multi_agent","config":{"agents":[{"goal":"inspect","tool":"invented.call","input":{}}]}}],"edges":[]}`,
			code: domain.CodeMultiAgentInvalidConfig,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := Validate(parseWorkflow(t, test.raw))
			if !hasIssue(result, test.code) {
				t.Fatalf("invalid agent tool was accepted: %+v", result.Issues)
			}
		})
	}

	draft := ValidateDraft(parseWorkflow(t, `{"nodes":[{"id":"agent","type":"agent","config":{"goal":"uppercase","tool":"text.uppercase","input":{}}}],"edges":[]}`))
	if !draft.Valid {
		t.Fatalf("draft should allow missing input for a known agent tool: %+v", draft.Issues)
	}
	wrongDraft := ValidateDraft(parseWorkflow(t, `{"nodes":[{"id":"agent","type":"agent","config":{"goal":"uppercase","tool":"text.uppercase","input":{"value":false}}}],"edges":[]}`))
	if !hasIssue(wrongDraft, domain.CodeAgentInvalidTool) {
		t.Fatalf("draft agent accepted a supplied wrong-typed input: %+v", wrongDraft.Issues)
	}
}
