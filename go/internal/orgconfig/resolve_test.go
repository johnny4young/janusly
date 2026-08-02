package orgconfig

import (
	"encoding/json"
	"testing"
)

// T-532: the layered resolution IS the contract — tenant row beats env
// beats catalog default, out-of-contract values fall through, ranges and
// closed enums reject.

func noEnv(string) (string, bool) { return "", false }

func TestResolutionLayering(t *testing.T) {
	// Default layer.
	value, source := ResolveValue("ai.rateLimitPerMin", nil, noEnv)
	if source != "default" || value == nil {
		t.Fatalf("default layer: %v %q", value, source)
	}
	// Env layer beats default.
	env := func(key string) (string, bool) {
		if key == "AI_RATE_LIMIT_PER_MIN" {
			return "33", true
		}
		return "", false
	}
	value, source = ResolveValue("ai.rateLimitPerMin", nil, env)
	if source != "env" || value != float64(33) {
		t.Fatalf("env layer: %v %q", value, source)
	}
	// Tenant row beats env.
	rows := map[string]json.RawMessage{"ai.rateLimitPerMin": json.RawMessage("44")}
	value, source = ResolveValue("ai.rateLimitPerMin", rows, env)
	if source != "tenant" || value != float64(44) {
		t.Fatalf("tenant layer: %v %q", value, source)
	}
}

func TestResolutionRejectsOutOfContract(t *testing.T) {
	// A wrong-typed tenant row falls through to the default.
	rows := map[string]json.RawMessage{"ai.rateLimitPerMin": json.RawMessage(`"not-a-number"`)}
	if _, source := ResolveValue("ai.rateLimitPerMin", rows, noEnv); source != "default" {
		t.Fatalf("wrong type must fall through: %q", source)
	}
	// A closed-enum violation falls through.
	rows = map[string]json.RawMessage{"ai.budgetExceededPolicy": json.RawMessage(`"explode"`)}
	if _, source := ResolveValue("ai.budgetExceededPolicy", rows, noEnv); source != "default" {
		t.Fatalf("enum violation must fall through: %q", source)
	}
	// An in-enum value sticks.
	rows = map[string]json.RawMessage{"ai.budgetExceededPolicy": json.RawMessage(`"block"`)}
	if value, source := ResolveValue("ai.budgetExceededPolicy", rows, noEnv); source != "tenant" || value != "block" {
		t.Fatalf("enum accept: %v %q", value, source)
	}
	// Unknown keys resolve to nothing.
	if value, source := ResolveValue("not.a.key", nil, noEnv); value != nil || source != "" {
		t.Fatalf("unknown key: %v %q", value, source)
	}
}

func TestResolveAllCoversTheCatalog(t *testing.T) {
	resolved := ResolveAll(nil, noEnv)
	if len(resolved) != len(Definitions) {
		t.Fatalf("ResolveAll must cover the whole catalog: %d vs %d", len(resolved), len(Definitions))
	}
}
