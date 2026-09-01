package domain

import (
	"encoding/json"
	"testing"
)

func TestValidateWaitUntilConfigUsesOneStrictGrammar(t *testing.T) {
	valid := []map[string]any{
		{"duration": "PT5M"},
		{"duration": "P1Y2M3DT4H5M6.5S"},
		{"until": "2026-09-01T12:30:00-05:00"},
	}
	for _, config := range valid {
		if err := ValidateWaitUntilConfig(config); err != nil {
			t.Fatalf("valid wait config %+v: %v", config, err)
		}
	}

	tests := []struct {
		name   string
		config map[string]any
		code   string
	}{
		{name: "missing", config: map[string]any{}, code: "wait_until_missing_duration"},
		{name: "both", config: map[string]any{"duration": "PT5M", "until": "2026-09-01T12:30:00Z"}, code: "wait_until_conflicting_time"},
		{name: "invented duration", config: map[string]any{"duration": "Pjunk"}, code: "wait_until_invalid_duration"},
		{name: "zero", config: map[string]any{"duration": "P0D"}, code: "wait_until_non_positive_duration"},
		{name: "wrong type", config: map[string]any{"duration": 300_000}, code: "wait_until_invalid_duration"},
		{name: "surrounding whitespace", config: map[string]any{"duration": " PT5M "}, code: "wait_until_invalid_duration"},
		{name: "runtime overflow", config: map[string]any{"duration": "P1000Y"}, code: "wait_until_invalid_duration"},
		{name: "below runtime resolution", config: map[string]any{"duration": "PT0.0000000001S"}, code: "wait_until_invalid_duration"},
		{name: "ambiguous instant", config: map[string]any{"until": "2026-09-01T12:30:00"}, code: "wait_until_invalid_until"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateWaitUntilConfig(test.config)
			configErr, ok := err.(*WaitingConfigError)
			if !ok || configErr.Code != test.code {
				t.Fatalf("config %+v: got %v, want code %s", test.config, err, test.code)
			}
		})
	}
}

func TestWorkflowValidationRejectsWaitUntilRuntimeFailure(t *testing.T) {
	raw, err := json.Marshal(map[string]any{
		"id": "wait-flow",
		"nodes": []any{map[string]any{
			"id": "wait", "type": "wait_until", "config": map[string]any{"duration": "Pjunk"},
		}},
		"edges": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	wf, parseIssues := Parse(raw)
	if wf == nil {
		t.Fatalf("parse: %+v", parseIssues)
	}
	result := Validate(wf, nil)
	if result.Valid {
		t.Fatalf("malformed wait duration must fail validation: %+v", result)
	}
	for _, issue := range result.Issues {
		if issue.Code == "wait_until_invalid_duration" && issue.NodeID == "wait" {
			return
		}
	}
	t.Fatalf("missing wait_until_invalid_duration: %+v", result.Issues)
}
