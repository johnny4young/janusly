package grammar

import (
	"strings"
	"testing"
)

// Cases port packages/shared/src/expression.test.ts at the parity pin; each
// group cites the it(...) block it mirrors. The TS tests ARE the grammar
// specification.

func specScope() Scope {
	return Scope{
		Context: map[string]any{
			"http":     map[string]any{"output": map[string]any{"statusCode": float64(200), "ok": true}},
			"approval": map[string]any{"output": map[string]any{"decision": "approved"}},
			"customer": map[string]any{"output": map[string]any{
				"createdAt": "2026-07-14T12:30:00Z",
				"email":     "operator@example.com",
				"message":   "payment failed: card declined",
				"tags":      []any{"priority", "billing"},
			}},
		},
		Inputs: map[string]any{"threshold": float64(10), "allowedTags": []any{"billing", "support"}},
	}
}

func evalOK(t *testing.T, expr string, scope Scope) bool {
	t.Helper()
	got, err := EvaluateExpression(expr, scope)
	if err != nil {
		t.Fatalf("%s: unexpected error %v", expr, err)
	}
	return got
}

func TestEvaluatesAllowedComparisonsAndBooleanOperators(t *testing.T) {
	// "evaluates allowed comparisons and boolean operators"
	scope := specScope()
	if !evalOK(t, "context.http.output.statusCode === 200 && context.http.output.ok === true", scope) {
		t.Fatal("strict equality chain must hold")
	}
	if !evalOK(t, "context.approval.output.decision === 'rejected' || inputs.threshold >= 10", scope) {
		t.Fatal("or-composition must hold")
	}
}

func TestRejectsArbitraryCodeExecution(t *testing.T) {
	// "rejects expressions that try to execute arbitrary code"
	result := ValidateExpression("process.exit()")
	if result.Valid || result.Code != "unsupported_token" ||
		result.Message != "Unsupported expression token: process.exit()" ||
		result.Token != "process.exit()" {
		t.Fatalf("wire-shape parity broken: %+v", result)
	}
	for _, expr := range []string{
		"context.http.output.ok; process.exit()",
		`context.customer.output.message.includes("failed")`,
		"context.customer.output.message matches /failed/",
	} {
		if ValidateExpression(expr).Valid {
			t.Fatalf("%s must be rejected", expr)
		}
	}
}

func TestStringAndCollectionOperators(t *testing.T) {
	// "supports string and collection operators without function calls"
	scope := specScope()
	cases := []struct {
		expr string
		want bool
	}{
		{"context.customer.output.message contains 'card declined'", true},
		{"context.customer.output.email startsWith 'operator@'", true},
		{"context.customer.output.message matches 'payment *: card ?eclined'", true},
		{"'billing' in context.customer.output.tags", true},
		{"context.approval.output.decision in ['approved', 'review']", true},
		{"'fraud' in inputs.allowedTags", false},
		{"context.customer.output.tags contains 'priority'", true},
		{"true in [false, true, null, 1]", true},
	}
	for _, tc := range cases {
		if got := evalOK(t, tc.expr, scope); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.expr, got, tc.want)
		}
	}
}

func TestLexicographicStringsAndNumericComparisons(t *testing.T) {
	// "compares strings lexicographically while preserving numeric comparisons"
	scope := specScope()
	cases := []struct {
		expr string
		want bool
	}{
		{"context.customer.output.createdAt >= '2026-07-01T00:00:00Z'", true},
		{"context.customer.output.createdAt < '2027-01-01T00:00:00Z'", true},
		{"'10' < '2'", true},
		{"inputs.threshold > 2", true},
		{"inputs.threshold > '2'", true},
	}
	for _, tc := range cases {
		if got := evalOK(t, tc.expr, scope); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.expr, got, tc.want)
		}
	}
}

func TestOperatorContractValidationAndRuntimeTypeDrift(t *testing.T) {
	// "validates operator contracts against empty scopes and keeps runtime
	// type drift non-fatal"
	valid := []string{
		"context.customer.output.message contains 'failed'",
		"context.customer.output.email startsWith 'operator'",
		"context.customer.output.message matches '*failed*'",
		"context.approval.output.decision in ['approved', 'rejected']",
		"context.customer.output.createdAt >= '2026-01-01'",
	}
	for _, expr := range valid {
		if !ValidateExpression(expr).Valid {
			t.Fatalf("%s must validate", expr)
		}
	}
	invalid := []string{
		"context.value in 'not-an-array'",
		"context.value startsWith 123",
		"context.value matches 123",
		"context.value > true",
		"false && context.value in 'not-an-array'",
		"true || context.value startsWith 123",
		"context.value in [context.other]",
		"context.value in [['nested']]",
	}
	for _, expr := range invalid {
		if ValidateExpression(expr).Valid {
			t.Fatalf("%s must be rejected", expr)
		}
	}

	scope := specScope()
	drift := []string{
		"context.http.output.ok > 0",
		"context.http.output.statusCode contains '20'",
		"'approved' in context.approval.output.decision",
	}
	for _, expr := range drift {
		if evalOK(t, expr, scope) {
			t.Fatalf("%s: runtime type drift must stay non-fatal false", expr)
		}
	}
}

func TestGlobBoundsAndLinearTime(t *testing.T) {
	// "bounds glob matching and handles long wildcard inputs in linear time"
	longScope := Scope{
		Context: map[string]any{"value": strings.Repeat("a", 10_000) + "z"},
		Inputs:  map[string]any{},
	}
	if !evalOK(t, "context.value matches 'a*z'", longScope) {
		t.Fatal("long wildcard match must succeed")
	}
	oversize := "context.value matches '" + strings.Repeat("*", 257) + "'"
	if ValidateExpression(oversize).Valid {
		t.Fatal("oversize pattern must fail validation")
	}
	_, err := EvaluateExpression("'value' matches '"+strings.Repeat("*", 257)+"'", specScope())
	if err == nil || !strings.Contains(err.Error(), "pattern exceeds 256 characters") {
		t.Fatalf("oversize pattern must error at runtime, got %v", err)
	}
}

func TestUndefinedVersusNullDistinction(t *testing.T) {
	// Semantics the reference inherits from JS and the port must pin: an
	// unresolved path is undefined, which loose-equals null but never
	// strict-equals it, and two unresolved paths strict-equal each other.
	scope := Scope{Context: map[string]any{"present": nil}, Inputs: map[string]any{}}
	cases := []struct {
		expr string
		want bool
	}{
		{"context.present === null", true},
		{"context.absent === null", false},
		{"context.absent == null", true},
		{"context.absent === context.otherabsent", true},
		{"context.absent !== null", true},
	}
	for _, tc := range cases {
		if got := evalOK(t, tc.expr, scope); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.expr, got, tc.want)
		}
	}
}

func TestLooseEqualityCoercions(t *testing.T) {
	// The grammar intentionally exposes JS loose equality; pin the scalar
	// coercion table the reference relies on.
	scope := Scope{
		Context: map[string]any{"count": float64(5), "flag": true, "text": "5"},
		Inputs:  map[string]any{},
	}
	cases := []struct {
		expr string
		want bool
	}{
		{"context.count == '5'", true},
		{"context.text == 5", true},
		{"context.flag == 1", true},
		{"context.flag == '1'", true},
		{"context.count != '6'", true},
		{"context.count == 'abc'", false},
	}
	for _, tc := range cases {
		if got := evalOK(t, tc.expr, scope); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.expr, got, tc.want)
		}
	}
}

func TestEmptyExpressionCodes(t *testing.T) {
	// validateExpression code mapping: empty input and empty operand.
	if got := ValidateExpression("   "); got.Code != "empty_expression" ||
		got.Message != "Expression cannot be empty" {
		t.Fatalf("empty expression mapping broken: %+v", got)
	}
	if got := ValidateExpression("context.a === "); got.Code != "empty_value" ||
		got.Message != "Expression value cannot be empty" {
		t.Fatalf("empty value mapping broken: %+v", got)
	}
}

func TestParenthesesAndNegation(t *testing.T) {
	// Grammar composition: outer-paren stripping and negation.
	scope := specScope()
	cases := []struct {
		expr string
		want bool
	}{
		{"(context.http.output.ok === true)", true},
		{"!(context.http.output.ok === false)", true},
		{"!context.http.output.ok", false},
	}
	for _, tc := range cases {
		if got := evalOK(t, tc.expr, scope); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.expr, got, tc.want)
		}
	}

	// Verified live against the reference evaluator: a parenthesized boolean
	// group composed with a further operator is OUTSIDE the grammar — parens
	// group only at the outermost level or after `!`. The port must reject
	// it with the identical token error, not quietly support more.
	_, err := EvaluateExpression("(context.http.output.statusCode === 200 || false) && !false", scope)
	if err == nil || err.Error() != "Unsupported expression token: 200 || false" {
		t.Fatalf("paren-group limitation parity broken: %v", err)
	}
}

func TestQuotedOperatorsDoNotSplit(t *testing.T) {
	// Operator characters inside quoted strings must not split the
	// expression — the reference's splitter is quote-aware.
	scope := Scope{
		Context: map[string]any{"note": "a && b || c"},
		Inputs:  map[string]any{},
	}
	if !evalOK(t, "context.note === 'a && b || c'", scope) {
		t.Fatal("quoted operators must stay literal text")
	}
	if !evalOK(t, "context.note contains ' && '", scope) {
		t.Fatal("word operators inside quotes must not split")
	}
}

func TestDomainValidatorAdapter(t *testing.T) {
	// The domain seam receives (valid, message) — wire the adapter shape.
	if valid, _ := DomainValidator("context.a === 1"); !valid {
		t.Fatal("valid expression must pass through the adapter")
	}
	valid, message := DomainValidator("process.exit()")
	if valid || message != "Unsupported expression token: process.exit()" {
		t.Fatalf("adapter must relay the reference message, got %q", message)
	}
}
