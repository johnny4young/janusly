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

// Edge conditions validate through the same seam at save time — the
// reference relays the validator's message under edge_invalid_condition
// (workflow-validation.ts:361-363).
func TestEdgeConditionsValidateThroughTheGrammar(t *testing.T) {
	invalid, issues := domain.Parse([]byte(`{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b","condition":"process.exit()"}]}`))
	if len(issues) > 0 {
		t.Fatalf("fixture must parse: %+v", issues)
	}
	result := domain.Validate(invalid, grammar.DomainValidator)
	found := false
	for _, issue := range result.Issues {
		if issue.Code == "edge_invalid_condition" &&
			issue.Message == "Unsupported expression token: process.exit()" &&
			issue.EdgeID == "edge_0" {
			found = true
		}
	}
	if !found {
		t.Fatalf("edge grammar rejection missing: %+v", result.Issues)
	}

	// The full operator set is legal on edges — including the word
	// operators the first grammar pass could have missed.
	valid, _ := domain.Parse([]byte(`{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b","condition":"context.a.output.tags contains 'billing' && context.a.output.status in ['open','held']"}]}`))
	if got := domain.Validate(valid, grammar.DomainValidator); !got.Valid {
		t.Fatalf("word operators must validate on edges: %+v", got.Issues)
	}

	// Contract-invalid operand types are caught statically (the empty-scope
	// contract pass), not left to silent runtime falsiness.
	contract, _ := domain.Parse([]byte(`{"nodes":[
		{"id":"a","type":"noop","config":{}},{"id":"b","type":"noop","config":{}}
	],"edges":[{"from":"a","to":"b","condition":"context.a.output.x in 'not-an-array'"}]}`))
	if got := domain.Validate(contract, grammar.DomainValidator); got.Valid {
		t.Fatal("operator-contract violations must be rejected at save")
	}
}
