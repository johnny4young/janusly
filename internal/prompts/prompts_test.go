package prompts

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDecodeVariablesRejectsAmbiguousOrUnboundedDeclarations(t *testing.T) {
	valid, err := DecodeVariables([]byte(`[{"name":"customer.id","required":true},{"name":"tone","default":"neutral"}]`))
	if err != nil || len(valid) != 2 || valid[0].Name != "customer.id" {
		t.Fatalf("valid declarations: %#v %v", valid, err)
	}

	tests := []struct {
		name string
		raw  []byte
	}{
		{name: "null", raw: []byte(`null`)},
		{name: "object", raw: []byte(`{"name":"topic"}`)},
		{name: "unknown field", raw: []byte(`[{"name":"topic","secret":true}]`)},
		{name: "trailing document", raw: []byte(`[] []`)},
		{name: "duplicate", raw: []byte(`[{"name":"topic"},{"name":"topic"}]`)},
		{name: "invalid name", raw: []byte(`[{"name":"topic/id"}]`)},
		{name: "oversized default", raw: mustMarshalVariables(t, []Variable{{Name: "topic", Default: strings.Repeat("x", MaxVariableDefaultBytes+1)}})},
	}
	tooMany := make([]Variable, MaxVariables+1)
	for i := range tooMany {
		tooMany[i].Name = "v" + strings.Repeat("x", i%32) + string(rune('A'+i%26))
	}
	tests = append(tests, struct {
		name string
		raw  []byte
	}{name: "too many", raw: mustMarshalVariables(t, tooMany)})

	largeDefaults := make([]Variable, 9)
	for i := range largeDefaults {
		largeDefaults[i] = Variable{Name: "v" + string(rune('A'+i)), Default: strings.Repeat("x", MaxVariableDefaultBytes)}
	}
	tests = append(tests, struct {
		name string
		raw  []byte
	}{name: "aggregate defaults", raw: mustMarshalVariables(t, largeDefaults)})

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := DecodeVariables(tt.raw); err == nil {
				t.Fatalf("invalid declaration was accepted: %s", tt.raw)
			}
		})
	}
}

func mustMarshalVariables(t *testing.T, variables []Variable) []byte {
	t.Helper()
	raw, err := json.Marshal(variables)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// The pure substitution half — declared variables enforce, the
// missing-variable error names the gap, unknown supplied keys are inert.
func TestSubstituteVariables(t *testing.T) {
	declared := []byte(`[{"name":"customer","required":true},{"name":"tone","default":"neutral"}]`)
	out, err := substituteVariables("Hello {{var.customer}} in {{var.tone}}", declared,
		map[string]string{"customer": "ACME", "tone": "formal"})
	if err != nil || out != "Hello ACME in formal" {
		t.Fatalf("substitution: %q %v", out, err)
	}
	// A declared variable without a supplied value is a NAMED error.
	_, err = substituteVariables("Hi {{var.customer}}", declared, map[string]string{"tone": "x"})
	var missing *MissingVariableError
	if !errors.As(err, &missing) || !strings.Contains(missing.Error(), "customer") {
		t.Fatalf("missing variable must name the gap: %v", err)
	}
	// A declared default fills the gap; an undeclared token passes through
	// untouched for the engine layer.
	out, err = substituteVariables("{{var.tone}} + {{var.unknown}}", declared, map[string]string{"customer": "x"})
	if err != nil || out != "neutral + {{var.unknown}}" {
		t.Fatalf("default + passthrough: %q %v", out, err)
	}
}

func TestSubstituteVariablesFailsClosedForInvalidStoredDeclarations(t *testing.T) {
	if _, err := substituteVariables("hello", []byte(`[{"name":"topic","unknown":true}]`), nil); err == nil ||
		!strings.Contains(err.Error(), "stored prompt variables are invalid") {
		t.Fatalf("invalid persisted declaration must fail closed: %v", err)
	}
}

func TestSubstituteVariablesBoundsExpansion(t *testing.T) {
	declared := []byte(`[{"name":"value","required":true}]`)
	template := strings.Repeat("{{var.value}}", 17)
	value := strings.Repeat("x", MaxVariableDefaultBytes)
	if _, err := substituteVariables(template, declared, map[string]string{"value": value}); err == nil ||
		!strings.Contains(err.Error(), "resolved prompt exceeds") {
		t.Fatalf("amplified substitution must reject: %v", err)
	}
}
