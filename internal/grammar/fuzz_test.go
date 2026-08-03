package grammar

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Fuzz targets for the two operator-facing grammars. The properties are
// robustness properties, not correctness oracles:
//
//   1. Never panic, never hang — any input, however hostile.
//   2. Validate/evaluate agreement: an expression that VALIDATES clean
//      must EVALUATE without a parse-shaped error (contract errors about
//      operand types are legitimate; crashes and syntax surprises are not).
//   3. Rendering is total over valid template syntax: unresolved paths
//      degrade per the lenient contract instead of erroring.
//
// Corpus seeds cover every operator and scope the grammar owns.

func FuzzValidateAndEvaluateExpression(f *testing.F) {
	seeds := []string{
		"context.a.output.statusCode === 200",
		"context.a.output.tags contains 'billing' && context.b.output.n >= 3",
		"context.a.output.state in ['open','held'] || !context.b.output.done",
		"inputs.threshold < 10 && (context.x.output.v !== null)",
		"context.a.output.name == \"ada\"",
		"process.exit()",
		"a ==",
		"''''",
		"context..output",
		"context.a.output.v in 'nope'",
		"(((((((",
		"context.a.output.v === 'unterminated",
		"\x00\x01\x02",
		"context.a.output.emoji === '🔥'",
	}
	for _, seed := range seeds {
		f.Add(seed)
	}
	scope := Scope{
		Context: map[string]any{"a": map[string]any{"output": map[string]any{
			"statusCode": float64(200), "tags": []any{"billing"}, "state": "open",
			"v": float64(1), "name": "ada", "emoji": "🔥",
		}}},
		Inputs: map[string]any{"threshold": float64(5)},
	}
	f.Fuzz(func(t *testing.T, expression string) {
		if len(expression) > 4096 {
			return // the API bounds request bodies long before this
		}
		result := ValidateExpression(expression)
		// Property 1 is implicit: reaching here without a panic.
		if !result.Valid {
			return
		}
		// Property 2: a clean validation must evaluate without a
		// parse-shaped error. Contract errors mention operator names;
		// panics are caught by the fuzzer itself.
		if _, err := EvaluateExpression(expression, scope); err != nil {
			message := err.Error()
			if strings.Contains(message, "Unsupported expression token") ||
				strings.Contains(message, "Unexpected token") {
				t.Fatalf("validated clean but failed to parse: %q → %v", expression, err)
			}
		}
	})
}

func FuzzRenderTemplate(f *testing.F) {
	seeds := []string{
		"{{context.a.output.name}}",
		"prefix {{context.a.output.n}} suffix",
		"{{inputs.own}} and {{context.missing.path.deep}}",
		"{{}}",
		"{{context.a.output.name",
		"}}{{",
		"{{secret.NOPE}}",
		"{{env.HOME}}",
		"plain text without tokens",
		"{{context.a.output.emoji}} 🔥 {{context.a.output.emoji}}",
	}
	for _, seed := range seeds {
		f.Add(seed)
	}
	scope := map[string]any{
		"context": map[string]any{"a": map[string]any{"output": map[string]any{
			"name": "ada", "n": float64(7), "emoji": "🔥",
		}}},
		"inputs": map[string]any{"own": "value"},
	}
	f.Fuzz(func(t *testing.T, template string) {
		if len(template) > 4096 || !utf8.ValidString(template) {
			return
		}
		if strings.Contains(template, "{{secret.") {
			// Missing secrets are a DOCUMENTED hard failure — skip the
			// property, the unit suite pins that contract.
			return
		}
		out, err := RenderTemplate(template, scope)
		if err != nil {
			t.Fatalf("lenient rendering must be total: %q → %v", template, err)
		}
		if s, ok := out.(string); ok && !utf8.ValidString(s) {
			t.Fatalf("render produced invalid UTF-8 from valid input: %q", template)
		}
	})
}
