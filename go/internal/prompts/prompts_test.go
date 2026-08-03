package prompts

import (
	"errors"
	"strings"
	"testing"
)

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
