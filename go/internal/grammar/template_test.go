package grammar

import (
	"errors"
	"reflect"
	"testing"
)

// Cases port packages/engine/src/template.test.ts at the parity pin; each
// cites the it(...) block it mirrors.

func fakeEnv(vars map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		v, ok := vars[name]
		return v, ok
	}
}

func fakeSecrets(vars map[string]string) func(string) (string, bool) {
	return fakeEnv(vars)
}

func TestGetByPathReadsNestedPaths(t *testing.T) {
	// "reads nested paths" + "returns undefined when the path does not
	// exist" + "handles null sources without throwing"
	source := map[string]any{"a": map[string]any{"b": map[string]any{"c": float64(42)}}}
	if v, ok := GetByPath(source, "a.b.c"); !ok || v != float64(42) {
		t.Fatalf("nested read broken: %v %v", v, ok)
	}
	if _, ok := GetByPath(map[string]any{"a": float64(1)}, "a.b.c"); ok {
		t.Fatal("missing path must read as absent")
	}
	if _, ok := GetByPath(nil, "a.b"); ok {
		t.Fatal("nil source must read as absent")
	}
}

func TestGetByPathReadsNumericArraySegments(t *testing.T) {
	// "reads numeric array segments"
	source := map[string]any{"items": []any{map[string]any{"id": "first"}}}
	if v, ok := GetByPath(source, "items.0.id"); !ok || v != "first" {
		t.Fatalf("array segment read broken: %v %v", v, ok)
	}
}

func renderScope() map[string]any {
	return map[string]any{
		"context": map[string]any{"http": map[string]any{"output": map[string]any{"statusCode": float64(200)}}},
		"inputs":  map[string]any{"name": "Ada"},
	}
}

func TestReplacesSimplePlaceholders(t *testing.T) {
	// "replaces simple placeholders with values from scope"
	got, err := RenderTemplate("hello {{inputs.name}}", renderScope())
	if err != nil || got != "hello Ada" {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestSerializesObjectsAsJSONInsideStrings(t *testing.T) {
	// "serializes objects as JSON inside strings"
	got, err := RenderTemplate("payload {{context.http.output}}", renderScope())
	if err != nil || got != `payload {"statusCode":200}` {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestRecursiveRenderPreservesNativeTypesForSingleRefs(t *testing.T) {
	// "recursively renders arrays and objects, preserving raw value types
	// for single-reference strings" — statusCode survives as a number.
	value := map[string]any{"items": []any{
		"{{inputs.name}}",
		map[string]any{"code": "{{context.http.output.statusCode}}"},
	}}
	got, err := RenderTemplate(value, renderScope())
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	want := map[string]any{"items": []any{"Ada", map[string]any{"code": float64(200)}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v want %#v", got, want)
	}
}

func TestSingleRefPreservesArrayReference(t *testing.T) {
	// "preserves an array reference when the entire string is one template"
	scope := map[string]any{
		"context": map[string]any{"trigger": map[string]any{"output": map[string]any{
			"customers": []any{map[string]any{"id": "c1"}, map[string]any{"id": "c2"}},
		}}},
		"inputs": map[string]any{},
	}
	got, err := RenderTemplate("{{context.trigger.output.customers}}", scope)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	want := []any{map[string]any{"id": "c1"}, map[string]any{"id": "c2"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("array identity lost: %#v", got)
	}
}

func TestSubstitutesEnvAndSecretPlaceholders(t *testing.T) {
	// "substitutes env and secret placeholders when available" — names are
	// uppercased before lookup.
	result, err := RenderTemplateWithRedactions(
		"{{env.foo_value}}-{{secret.secret_token}}",
		map[string]any{"context": map[string]any{}, "inputs": map[string]any{}},
		RenderOptions{
			LookupEnv:    fakeEnv(map[string]string{"FOO_VALUE": "bar"}),
			LookupSecret: fakeSecrets(map[string]string{"SECRET_TOKEN": "s3cret"}),
		},
	)
	if err != nil || result.Rendered != "bar-s3cret" {
		t.Fatalf("got %v err %v", result.Rendered, err)
	}
}

func TestMapInputAcceptsNil(t *testing.T) {
	// "mapInput accepts empty or null mappings"
	got, err := MapInput(nil, map[string]any{})
	if err != nil || !reflect.DeepEqual(got, map[string]any{}) {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestCollectsUnresolvedPathsOnceAndAnonymizesEnvNames(t *testing.T) {
	// "collects unresolved paths once and normalizes missing env reference
	// names" — insertion-ordered, deduplicated, env name never leaks.
	result, err := RenderTemplateWithRedactions(
		map[string]any{
			"first":    "{{context.fetch.output.json.customer.id}}",
			"repeated": "id={{ context.fetch.output.json.customer.id }}",
			"env":      "{{env.MISSING_PRIVATE_ENDPOINT}}",
		},
		map[string]any{
			"context": map[string]any{"fetch": map[string]any{"output": map[string]any{}}},
			"inputs":  map[string]any{},
		},
		RenderOptions{LookupEnv: fakeEnv(nil)},
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	want := map[string]any{"first": "", "repeated": "id=", "env": ""}
	if !reflect.DeepEqual(result.Rendered, want) {
		t.Fatalf("rendered %#v", result.Rendered)
	}
	// Map iteration order varies in Go, so assert set membership + size
	// instead of the reference's insertion order (divergence noted in plan).
	if len(result.UnresolvedPaths) != 2 {
		t.Fatalf("dedup broken: %v", result.UnresolvedPaths)
	}
	seen := map[string]bool{}
	for _, p := range result.UnresolvedPaths {
		seen[p] = true
		if p == "env.MISSING_PRIVATE_ENDPOINT" {
			t.Fatal("env name must be anonymized")
		}
	}
	if !seen["context.fetch.output.json.customer.id"] || !seen["env.*"] {
		t.Fatalf("expected anonymized entries, got %v", result.UnresolvedPaths)
	}
}

func TestPresentNullAndDefinedEmptyEnvAreNotMissing(t *testing.T) {
	// "does not classify present null values or defined empty env values
	// as missing"
	result, err := RenderTemplateWithRedactions(
		map[string]any{
			"nullable": "{{context.record.nullable}}",
			"emptyEnv": "{{env.EMPTY_BUT_DEFINED}}",
			"missing":  "{{context.record.absent}}",
		},
		map[string]any{
			"context": map[string]any{"record": map[string]any{"nullable": nil}},
			"inputs":  map[string]any{},
		},
		RenderOptions{LookupEnv: fakeEnv(map[string]string{"EMPTY_BUT_DEFINED": ""})},
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	want := map[string]any{"nullable": "", "emptyEnv": "", "missing": ""}
	if !reflect.DeepEqual(result.Rendered, want) {
		t.Fatalf("rendered %#v", result.Rendered)
	}
	if len(result.UnresolvedPaths) != 1 || result.UnresolvedPaths[0] != "context.record.absent" {
		t.Fatalf("only the truly absent path counts: %v", result.UnresolvedPaths)
	}
}

func TestDeferredRootsStayVerbatim(t *testing.T) {
	// "preserves deferred roots while resolving immediate values in the
	// same mapping" — the loop executor's item/index bind later.
	result, err := RenderTemplateWithRedactions(
		map[string]any{"line": "{{context.prefix}}-{{item.id}}-{{index}}"},
		map[string]any{"context": map[string]any{"prefix": "customer"}, "inputs": map[string]any{}},
		RenderOptions{DeferredRoots: []string{"item", "index"}},
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	want := map[string]any{"line": "customer-{{item.id}}-{{index}}"}
	if !reflect.DeepEqual(result.Rendered, want) {
		t.Fatalf("rendered %#v", result.Rendered)
	}
	if len(result.UnresolvedPaths) != 0 {
		t.Fatalf("deferred roots are not unresolved: %v", result.UnresolvedPaths)
	}
}

func TestMissingSecretIsAHardFailure(t *testing.T) {
	// "preserves the existing hard failure for a missing secret reference"
	// — an empty-string secret is missing too.
	_, err := RenderTemplateWithRedactions(
		map[string]any{"secret": "{{secret.MISSING_CUSTOMER_TOKEN}}"},
		map[string]any{"context": map[string]any{}, "inputs": map[string]any{}},
		RenderOptions{LookupSecret: fakeSecrets(map[string]string{"MISSING_CUSTOMER_TOKEN": ""})},
	)
	var missing *MissingSecretError
	if !errors.As(err, &missing) || err.Error() != "Missing secret: MISSING_CUSTOMER_TOKEN" {
		t.Fatalf("expected the hard failure, got %v", err)
	}
}

func TestEnvValuesMeetingTheLengthFloorAreRedacted(t *testing.T) {
	// "captures env values that meet the length floor" + "skips env values
	// shorter than the 4-char floor" + "does not add the empty string when
	// the env var is unset"
	long, err := RenderTemplateWithRedactions(
		map[string]any{"token": "{{env.OPENAI_API_KEY}}"},
		map[string]any{"context": map[string]any{}, "inputs": map[string]any{}},
		RenderOptions{LookupEnv: fakeEnv(map[string]string{"OPENAI_API_KEY": "sk-fake-secret-123456"})},
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !reflect.DeepEqual(long.Rendered, map[string]any{"token": "sk-fake-secret-123456"}) ||
		len(long.RedactedValues) != 1 || long.RedactedValues[0] != "sk-fake-secret-123456" {
		t.Fatalf("long env value must be tracked: %+v", long)
	}

	short, _ := RenderTemplateWithRedactions(
		map[string]any{"mode": "{{env.NODE_ENV}}"},
		map[string]any{"context": map[string]any{}, "inputs": map[string]any{}},
		RenderOptions{LookupEnv: fakeEnv(map[string]string{"NODE_ENV": "dev"})},
	)
	if !reflect.DeepEqual(short.Rendered, map[string]any{"mode": "dev"}) || len(short.RedactedValues) != 0 {
		t.Fatalf("short toy values must render verbatim untracked: %+v", short)
	}

	unset, _ := RenderTemplateWithRedactions(
		map[string]any{"token": "{{env.TOTALLY_UNSET_VAR}}"},
		map[string]any{"context": map[string]any{}, "inputs": map[string]any{}},
		RenderOptions{LookupEnv: fakeEnv(nil)},
	)
	for _, v := range unset.RedactedValues {
		if v == "" {
			t.Fatal("the empty string must never enter the redaction list")
		}
	}
}

func TestRedactValuesScrubsSimulatedExecutorOutput(t *testing.T) {
	// "redactValues scrubs env-derived values from a simulated executor
	// output (end-to-end)"
	result, err := RenderTemplateWithRedactions(
		map[string]any{"token": "{{env.OPENAI_API_KEY}}"},
		map[string]any{"context": map[string]any{}, "inputs": map[string]any{}},
		RenderOptions{LookupEnv: fakeEnv(map[string]string{"OPENAI_API_KEY": "sk-leaky-key-abcdef-987654321"})},
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	executorOutput := map[string]any{
		"message": "used token sk-leaky-key-abcdef-987654321 to call upstream",
		"nested":  map[string]any{"copied": "sk-leaky-key-abcdef-987654321"},
	}
	want := map[string]any{
		"message": "used token [redacted] to call upstream",
		"nested":  map[string]any{"copied": "[redacted]"},
	}
	if got := RedactValues(executorOutput, result.RedactedValues); !reflect.DeepEqual(got, want) {
		t.Fatalf("scrub broken: %#v", got)
	}
}

func TestCapturesEnvAndSecretValuesInTheSamePass(t *testing.T) {
	// "captures env AND secret values in the same render pass"
	result, err := RenderTemplateWithRedactions(
		"env={{env.SOME_API_KEY}} secret={{secret.SECRET_TOKEN}}",
		map[string]any{"context": map[string]any{}, "inputs": map[string]any{}},
		RenderOptions{
			LookupEnv:    fakeEnv(map[string]string{"SOME_API_KEY": "env-key-12345678"}),
			LookupSecret: fakeSecrets(map[string]string{"SECRET_TOKEN": "secret-value-87654321"}),
		},
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	seen := map[string]bool{}
	for _, v := range result.RedactedValues {
		seen[v] = true
	}
	if !seen["env-key-12345678"] || !seen["secret-value-87654321"] {
		t.Fatalf("both channels must be tracked: %v", result.RedactedValues)
	}
}

func TestUnresolvedTemplatePathErrorEnvelope(t *testing.T) {
	// The strict-policy envelope: exact message, bounded paths, truncation
	// marker — the reference's UnresolvedTemplatePathError contract.
	one := NewUnresolvedTemplatePathError([]string{"context.a.output.x"})
	if one.Error() != "Node config contains 1 unresolved template path" || one.Truncated {
		t.Fatalf("singular envelope broken: %v", one)
	}
	many := make([]string, 25)
	for i := range many {
		many[i] = "context.n.output.f"
	}
	bounded := NewUnresolvedTemplatePathError(many)
	if bounded.Error() != "Node config contains 25 unresolved template paths" ||
		len(bounded.Paths) != MaxRecordedUnresolvedPaths || !bounded.Truncated {
		t.Fatalf("bounded envelope broken: %+v", bounded)
	}
}
