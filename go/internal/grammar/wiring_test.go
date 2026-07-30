package grammar_test

import (
	"testing"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

// Proves the seam end to end: workflow validation with the real grammar
// rejects an out-of-grammar condition with the reference's message, and
// accepts a well-formed one — no partial evaluation, ever.
func TestDomainValidationUsesGrammarValidator(t *testing.T) {
	invalid, issues := domain.Parse([]byte(`{"nodes":[
		{"id":"c","type":"condition","config":{"expression":"process.exit()"}}
	],"edges":[]}`))
	if len(issues) > 0 {
		t.Fatalf("fixture must parse: %+v", issues)
	}
	// The reference relays the validator's message verbatim
	// (workflow-validation.ts:151 — `expression.message ?? "Invalid
	// condition expression"`), so no prefix is added here either.
	result := domain.Validate(invalid, grammar.DomainValidator)
	found := false
	for _, issue := range result.Issues {
		if issue.Code == "condition_invalid_expression" &&
			issue.Message == "Unsupported expression token: process.exit()" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the grammar-backed rejection, got %+v", result.Issues)
	}

	valid, _ := domain.Parse([]byte(`{"nodes":[
		{"id":"c","type":"condition","config":{"expression":"context.http.output.statusCode === 200"}}
	],"edges":[]}`))
	if got := domain.Validate(valid, grammar.DomainValidator); !got.Valid {
		t.Fatalf("well-formed condition must validate: %+v", got.Issues)
	}
}
