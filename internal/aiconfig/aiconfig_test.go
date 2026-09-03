package aiconfig

import (
	"testing"

	"github.com/johnny4young/janusly/internal/ai"
)

func TestSimulatorEndpointFailsClosedUnlessFullyBound(t *testing.T) {
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "openai, anthropic")

	for name, endpoint := range map[string]string{
		"missing":          "",
		"relative":         "/v1/mock",
		"userinfo":         "http://user:pass@127.0.0.1:4010",
		"paid host":        "https://api.anthropic.com",
		"paid host suffix": "https://mock.anthropic.com/v1",
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", endpoint)
			base, requested, valid := simulatorEndpoint()
			if base != "" || !requested || valid {
				t.Fatalf("invalid requested simulator must fail closed: base=%q requested=%v valid=%v", base, requested, valid)
			}
		})
	}

	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", "http://provider-simulator:4010/v1")
	base, requested, valid := simulatorEndpoint()
	if base != "http://provider-simulator:4010/v1" || !requested || !valid {
		t.Fatalf("valid local simulator was rejected: base=%q requested=%v valid=%v", base, requested, valid)
	}
}

func TestSimulatorEndpointIsInertWithoutEveryGate(t *testing.T) {
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", "http://127.0.0.1:4010")
	if base, requested, valid := simulatorEndpoint(); base != "" || requested || valid {
		t.Fatalf("partial simulator gates must be inert: base=%q requested=%v valid=%v", base, requested, valid)
	}
}

func TestSimulatorNeverReceivesLiveAnthropicCredential(t *testing.T) {
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", "http://127.0.0.1:4010")

	cfg := ai.Config{APIKey: "sk-ant-live-must-not-leave", Model: ai.DefaultModel}
	applySimulatorConfig(&cfg)
	if cfg.APIKey != localSimulatorAPIKey || cfg.APIKey == "sk-ant-live-must-not-leave" ||
		cfg.BaseURL != "http://127.0.0.1:4010" || !cfg.ProviderSimulated {
		t.Fatalf("simulator config must replace the live key: %+v", cfg)
	}

	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", "https://api.anthropic.com")
	cfg = ai.Config{APIKey: "sk-ant-live-must-not-leave", Model: ai.DefaultModel}
	applySimulatorConfig(&cfg)
	if cfg.APIKey != "" || cfg.BaseURL != "" || cfg.ProviderSimulated {
		t.Fatalf("invalid requested simulator must expose provider-free config: %+v", cfg)
	}
}
