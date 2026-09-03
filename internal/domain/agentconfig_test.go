package domain

import (
	"strings"
	"testing"
)

func TestResolveAgentRuntimeConfigNormalizesDefaultsAndBounds(t *testing.T) {
	resolved, err := ResolveAgentRuntimeConfig(nil, AgentDefaultMaxSteps, false)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Planner != "rules" || resolved.MaxSteps != AgentDefaultMaxSteps || resolved.HasTimeout || resolved.Reflection {
		t.Fatalf("unexpected defaults: %+v", resolved)
	}

	resolved, err = ResolveAgentRuntimeConfig(map[string]any{
		"planner": "ai", "maxSteps": 50, "timeoutMs": 600_000,
		"reflection": true, "allowWriteTools": true,
	}, AgentDefaultMaxSteps, false)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Planner != "ai" || resolved.MaxSteps != 50 || resolved.TimeoutMS != 600_000 ||
		!resolved.HasTimeout || !resolved.Reflection || !resolved.AllowWrites {
		t.Fatalf("unexpected resolved config: %+v", resolved)
	}
}

func TestResolveAgentRuntimeConfigRejectsEveryRuntimeShapeMismatch(t *testing.T) {
	tests := []struct {
		name   string
		config map[string]any
		kind   AgentConfigErrorKind
	}{
		{name: "planner type", config: map[string]any{"planner": 1}, kind: AgentConfigInvalidPlanner},
		{name: "planner enum", config: map[string]any{"planner": "other"}, kind: AgentConfigInvalidPlanner},
		{name: "fractional steps", config: map[string]any{"maxSteps": 1.5}, kind: AgentConfigInvalidMaxSteps},
		{name: "too many steps", config: map[string]any{"maxSteps": 51}, kind: AgentConfigInvalidMaxSteps},
		{name: "timeout zero", config: map[string]any{"timeoutMs": 0}, kind: AgentConfigInvalidTimeout},
		{name: "timeout too high", config: map[string]any{"timeoutMs": 600_001}, kind: AgentConfigInvalidTimeout},
		{name: "reflection type", config: map[string]any{"reflection": "yes"}, kind: AgentConfigInvalidBoolean},
		{name: "write opt-in type", config: map[string]any{"allowWriteTools": "true"}, kind: AgentConfigInvalidBoolean},
		{name: "model type", config: map[string]any{"model": []any{"x"}}, kind: AgentConfigInvalidField},
		{name: "system prompt ref type", config: map[string]any{"systemPromptRef": "saved"}, kind: AgentConfigInvalidField},
		{name: "system prompt ref version", config: map[string]any{"systemPromptRef": map[string]any{"name": "saved", "version": 1.5}}, kind: AgentConfigInvalidField},
		{name: "prompt variable value", config: map[string]any{"variables": map[string]any{"customer": 42}}, kind: AgentConfigInvalidField},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ResolveAgentRuntimeConfig(test.config, AgentDefaultMaxSteps, false)
			configError, ok := err.(*AgentConfigError)
			if !ok || configError.Kind != test.kind {
				t.Fatalf("got %T %v, want kind %s", err, err, test.kind)
			}
		})
	}
}

func TestResolveMultiAgentRuntimeConfigRejectsCrewBeforeExecution(t *testing.T) {
	tooMany := make([]any, MultiAgentMaxAgents+1)
	for index := range tooMany {
		tooMany[index] = map[string]any{"goal": "bounded"}
	}
	tests := []struct {
		name   string
		config map[string]any
		kind   AgentConfigErrorKind
	}{
		{name: "missing", config: map[string]any{}, kind: MultiAgentConfigMissingAgents},
		{name: "empty", config: map[string]any{"agents": []any{}}, kind: MultiAgentConfigMissingAgents},
		{name: "too many", config: map[string]any{"agents": tooMany}, kind: MultiAgentConfigInvalidAgents},
		{name: "member scalar", config: map[string]any{"agents": []any{"bad"}}, kind: MultiAgentConfigInvalidAgents},
		{name: "member invalid", config: map[string]any{"agents": []any{map[string]any{"maxSteps": 51}}}, kind: MultiAgentConfigInvalidAgents},
		{name: "member goal missing", config: map[string]any{"agents": []any{map[string]any{}}}, kind: MultiAgentConfigInvalidAgents},
		{name: "member goal empty", config: map[string]any{"agents": []any{map[string]any{"goal": "  "}}}, kind: MultiAgentConfigInvalidAgents},
		{name: "mode", config: map[string]any{"agents": []any{map[string]any{}}, "mode": "race"}, kind: MultiAgentConfigInvalidMode},
		{name: "aggregation", config: map[string]any{"agents": []any{map[string]any{}}, "aggregation": "random"}, kind: MultiAgentConfigInvalidAgg},
		{name: "continue type", config: map[string]any{"agents": []any{map[string]any{}}, "continueOnError": 1}, kind: MultiAgentConfigInvalidBool},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ResolveMultiAgentRuntimeConfig(test.config)
			configError, ok := err.(*AgentConfigError)
			if !ok || configError.Kind != test.kind {
				t.Fatalf("got %T %v, want kind %s", err, err, test.kind)
			}
		})
	}
}

func TestResolveMultiAgentRuntimeConfigAcceptsExplicitGoals(t *testing.T) {
	resolved, err := ResolveMultiAgentRuntimeConfig(map[string]any{
		"agents": []any{map[string]any{"name": "reviewer", "goal": "Review the evidence"}},
	})
	if err != nil || len(resolved.Agents) != 1 {
		t.Fatalf("explicit member goal rejected: %+v %v", resolved, err)
	}
}

func TestAgentConfiguredToolRequiresObjectInput(t *testing.T) {
	if _, _, err := AgentConfiguredTool(map[string]any{"tool": "text.uppercase", "input": "x"}); err == nil {
		t.Fatal("scalar input was accepted")
	}
	tool, input, err := AgentConfiguredTool(map[string]any{"tool": " text.uppercase ", "input": map[string]any{"value": "x"}})
	if err != nil || tool != "text.uppercase" || !strings.EqualFold(input["value"].(string), "x") {
		t.Fatalf("unexpected configured tool: %q %+v %v", tool, input, err)
	}
}
