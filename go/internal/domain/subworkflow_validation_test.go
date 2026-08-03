package domain

import (
	"encoding/json"
	"testing"
)

func validateSubworkflowConfig(t *testing.T, config map[string]any) ValidationResult {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"id": "parent",
		"nodes": []any{map[string]any{
			"id": "child", "type": "subworkflow", "config": config,
		}},
		"edges": []any{},
	})
	if err != nil {
		t.Fatalf("marshal workflow: %v", err)
	}
	wf, issues := Parse(raw)
	if wf == nil {
		t.Fatalf("parse workflow: %+v", issues)
	}
	return Validate(wf, nil)
}

func TestSubworkflowCompositionValidation(t *testing.T) {
	for _, version := range []any{2, workflowVersionMax} {
		result := validateSubworkflowConfig(t, map[string]any{
			"workflowId": "child-flow", "version": version,
		})
		if !result.Valid || len(result.Issues) != 0 {
			t.Fatalf("valid version %v: %+v", version, result)
		}
	}

	tests := []struct {
		name   string
		config map[string]any
		code   string
	}{
		{name: "missing workflow", config: map[string]any{}, code: CodeSubworkflowMissingWorkflow},
		{name: "self reference", config: map[string]any{"workflowId": "parent"}, code: CodeSubworkflowSelfReference},
		{name: "trimmed self reference", config: map[string]any{"workflowId": " parent "}, code: CodeSubworkflowSelfReference},
		{name: "zero", config: map[string]any{"workflowId": "child-flow", "version": 0}, code: CodeSubworkflowInvalidVersion},
		{name: "fraction", config: map[string]any{"workflowId": "child-flow", "version": 1.5}, code: CodeSubworkflowInvalidVersion},
		{name: "overflow", config: map[string]any{"workflowId": "child-flow", "version": workflowVersionMax + 1}, code: CodeSubworkflowInvalidVersion},
		{name: "string", config: map[string]any{"workflowId": "child-flow", "version": "2"}, code: CodeSubworkflowInvalidVersion},
		{name: "null", config: map[string]any{"workflowId": "child-flow", "version": nil}, code: CodeSubworkflowInvalidVersion},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := validateSubworkflowConfig(t, test.config)
			if result.Valid {
				t.Fatalf("config must be invalid: %+v", test.config)
			}
			for _, issue := range result.Issues {
				if issue.Code == test.code && issue.NodeID == "child" {
					return
				}
			}
			t.Fatalf("missing %s: %+v", test.code, result.Issues)
		})
	}
}
