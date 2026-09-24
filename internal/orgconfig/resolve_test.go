package orgconfig

import (
	"encoding/json"
	"testing"
)

// The layered resolution IS the contract — tenant row beats env
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
	// Stored rows pass through the same complete normalizer as writes. This
	// protects against legacy/direct SQL rows after a policy is tightened.
	rows = map[string]json.RawMessage{"ai.operatorGuidance": json.RawMessage(`"use postgres://user:pass@db/prod"`)}
	if value, source := ResolveValue("ai.operatorGuidance", rows, noEnv); source != "default" || value != "" {
		t.Fatalf("stored guidance secret must fall through: %v %q", value, source)
	}
	rows = map[string]json.RawMessage{"memory.allowedKinds": json.RawMessage(`"run_summary,unknown"`)}
	if value, source := ResolveValue("memory.allowedKinds", rows, noEnv); source != "default" || value != "" {
		t.Fatalf("stored custom-validator violation must fall through: %v %q", value, source)
	}
	rows = map[string]json.RawMessage{"email.provider": json.RawMessage(`" simulator "`)}
	if value, source := ResolveValue("email.provider", rows, noEnv); source != "tenant" || value != "simulator" {
		t.Fatalf("stored strings must normalize: %v %q", value, source)
	}
	rows = map[string]json.RawMessage{"ai.generationCandidates": json.RawMessage(`3.9`)}
	if value, source := ResolveValue("ai.generationCandidates", rows, noEnv); source != "tenant" || value != float64(3) {
		t.Fatalf("stored integers must normalize: %v %q", value, source)
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

func TestResolutionNormalizesEnvironmentValues(t *testing.T) {
	envValues := map[string]string{
		"JANUSLY_AI_GENERATION_CANDIDATES": "3.9",
		"JANUSLY_MAILER_PROVIDER":          " simulator ",
		"JANUSLY_MAILER_FROM":              " sender@example.com ",
		"JANUSLY_MCP_ALLOWED_COMMANDS":     "",
	}
	env := func(key string) (string, bool) {
		value, ok := envValues[key]
		return value, ok
	}

	value, source := ResolveValue("ai.generationCandidates", nil, env)
	if source != "env" || value != float64(3) {
		t.Fatalf("integer env normalization: %v %q", value, source)
	}
	value, source = ResolveValue("email.provider", nil, env)
	if source != "env" || value != "simulator" {
		t.Fatalf("string env normalization: %v %q", value, source)
	}
	value, source = ResolveValue("email.from", nil, env)
	if source != "env" || value != "sender@example.com" {
		t.Fatalf("open string env normalization: %v %q", value, source)
	}
	value, source = ResolveValue("mcp.clientCommandAllowlist", nil, env)
	if source != "default" || value != "" {
		t.Fatalf("empty env must fall through: %v %q", value, source)
	}

	envValues["JANUSLY_AI_GENERATION_CANDIDATES"] = "NaN"
	if value, source = ResolveValue("ai.generationCandidates", nil, env); source != "default" || value != float64(1) {
		t.Fatalf("non-finite env must fall through: %v %q", value, source)
	}
	envValues["JANUSLY_MAILER_FROM"] = "Bearer abc"
	if value, source = ResolveValue("email.from", nil, env); source != "default" || value != "onboarding@resend.dev" {
		t.Fatalf("secret-shaped env must fall through: %v %q", value, source)
	}
	envValues["OLLAMA_BASE_URL"] = "https://user:password@embeddings.example/path"
	if value, source = ResolveValue("memory.embeddingBaseUrl", nil, env); source != "default" || value != "" {
		t.Fatalf("invalid embedding URL env must fall through: %v %q", value, source)
	}
}

// Empty is an intentional override, not an instruction to inherit. In
// particular, an organization can revoke stdio commands allowed by the host.
func TestExplicitEmptyTenantStringOverridesEnvironment(t *testing.T) {
	for _, tc := range []struct {
		key, envKey, fallback string
	}{
		{"mcp.clientCommandAllowlist", "JANUSLY_MCP_ALLOWED_COMMANDS", "node,uvx"},
		{"memory.embeddingModel", "JANUSLY_EMBEDDING_MODEL", "custom-model"},
		{"memory.embeddingBaseUrl", "OLLAMA_BASE_URL", "https://embeddings.example"},
	} {
		t.Run(tc.key, func(t *testing.T) {
			lookup := func(key string) (string, bool) { return tc.fallback, key == tc.envKey }
			for _, state := range []struct {
				name          string
				rows          map[string]json.RawMessage
				value, source string
			}{
				{"absent", nil, tc.fallback, "env"},
				{"empty", map[string]json.RawMessage{tc.key: json.RawMessage(`""`)}, "", "tenant"},
				{"whitespace", map[string]json.RawMessage{tc.key: json.RawMessage(`"  "`)}, "", "tenant"},
				{"invalid", map[string]json.RawMessage{tc.key: json.RawMessage(`false`)}, tc.fallback, "env"},
			} {
				t.Run(state.name, func(t *testing.T) {
					value, source := ResolveValue(tc.key, state.rows, lookup)
					if value != state.value || source != state.source {
						t.Fatalf("resolved (%v, %s), want (%v, %s)", value, source, state.value, state.source)
					}
				})
			}
		})
	}
}
