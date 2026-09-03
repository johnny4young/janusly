package executors

import (
	"strings"
	"testing"
)

func TestResolveCrewAgentConfigInheritsNodeTimeout(t *testing.T) {
	in := Input{Config: map[string]any{
		"timeoutMs": float64(12_345),
	}}
	resolved, err := resolveCrewAgentConfig(in, map[string]any{"goal": "inspect"}, 0, map[string]any{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resolved["timeoutMs"] != float64(12_345) {
		t.Fatalf("node timeout was not inherited: %+v", resolved)
	}

	resolved, err = resolveCrewAgentConfig(in, map[string]any{
		"goal": "inspect", "timeoutMs": float64(321),
	}, 0, map[string]any{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resolved["timeoutMs"] != float64(321) {
		t.Fatalf("member timeout must override node default: %+v", resolved)
	}
}

func TestResolveCrewAgentConfigRejectsMissingAndEmptyResolvedGoal(t *testing.T) {
	for name, agent := range map[string]map[string]any{
		"missing": {},
		"empty":   {"goal": "   "},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := resolveCrewAgentConfig(Input{}, agent, 2, map[string]any{}, nil); err == nil ||
				!strings.Contains(err.Error(), "requires a non-empty goal") {
				t.Fatalf("missing goal was not rejected: %v", err)
			}
		})
	}
	if _, err := resolveCrewAgentConfig(Input{}, map[string]any{
		"goal": "{{context.empty}}",
	}, 0, map[string]any{"empty": ""}, nil); err == nil || !strings.Contains(err.Error(), "resolved to an empty goal") {
		t.Fatalf("empty rendered goal was not rejected: %v", err)
	}
}
