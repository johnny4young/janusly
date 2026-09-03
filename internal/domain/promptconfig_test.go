package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidatePromptNameUsesAddressableURLSafeGrammar(t *testing.T) {
	for _, name := range []string{"triage", "triage.v2", "PagerDuty_12h", "a-b"} {
		if err := ValidatePromptName(name); err != nil {
			t.Fatalf("valid name %q: %v", name, err)
		}
	}

	for _, name := range []string{
		"", " triage", "triage ", ".hidden", "_private", "triage/es", "triage?draft", "triagé",
		strings.Repeat("x", PromptReferenceMaxNameLength+1),
	} {
		if err := ValidatePromptName(name); err == nil {
			t.Fatalf("invalid name %q was accepted", name)
		}
	}
}

func TestResolvePromptReferenceNormalizesSupportedNumericRepresentations(t *testing.T) {
	for _, version := range []any{float64(7), float32(7), 7, int32(7), int64(7), uint64(7), json.Number("7")} {
		ref, present, err := ResolvePromptReference(map[string]any{
			"promptRef": map[string]any{"name": "triage", "version": version},
		}, "promptRef")
		if err != nil || !present || ref.Name != "triage" || ref.Version != 7 {
			t.Fatalf("version %T(%v): ref=%+v present=%v err=%v", version, version, ref, present, err)
		}
	}

	ref, present, err := ResolvePromptReference(map[string]any{
		"promptRef": map[string]any{"name": "triage"},
	}, "promptRef")
	if err != nil || !present || ref.Version != 0 {
		t.Fatalf("active reference: ref=%+v present=%v err=%v", ref, present, err)
	}
}

func TestResolvePromptReferenceRejectsMalformedOrUnrepresentableValues(t *testing.T) {
	tests := []any{
		nil,
		"triage",
		map[string]any{},
		map[string]any{"name": "   "},
		map[string]any{"name": ".hidden"},
		map[string]any{"name": "triage/es"},
		map[string]any{"name": strings.Repeat("x", PromptReferenceMaxNameLength+1)},
		map[string]any{"name": "triage", "version": nil},
		map[string]any{"name": "triage", "version": 0},
		map[string]any{"name": "triage", "version": -1},
		map[string]any{"name": "triage", "version": 1.5},
		map[string]any{"name": "triage", "version": uint64(PromptReferenceMaxVersion) + 1},
	}
	for _, raw := range tests {
		if _, present, err := ResolvePromptReference(map[string]any{"systemPromptRef": raw}, "systemPromptRef"); !present || err == nil {
			t.Fatalf("malformed reference %T(%v) was accepted: present=%v err=%v", raw, raw, present, err)
		}
	}
}

func TestResolvePromptVariablesRejectsPartialCoercion(t *testing.T) {
	resolved, err := ResolvePromptVariables(map[string]any{
		"variables": map[string]any{"customer": "Ada", "priority": "high"},
	})
	if err != nil || resolved["customer"] != "Ada" || resolved["priority"] != "high" {
		t.Fatalf("valid variables: %+v %v", resolved, err)
	}

	for _, raw := range []any{nil, "customer=Ada", []any{"Ada"}, map[string]any{"customer": 42}} {
		if _, err := ResolvePromptVariables(map[string]any{"variables": raw}); err == nil {
			t.Fatalf("malformed variables %T(%v) were accepted", raw, raw)
		}
	}
}
