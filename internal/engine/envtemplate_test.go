package engine

import (
	"testing"

	"github.com/johnny4young/janusly/internal/grammar"
)

func renderNodeConfig(t *testing.T, dispatcher *Dispatcher, config map[string]any) map[string]any {
	t.Helper()
	result, err := grammar.RenderTemplateWithRedactions(
		config,
		map[string]any{"context": map[string]any{}, "inputs": config},
		dispatcher.renderOpts,
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	rendered, ok := result.Rendered.(map[string]any)
	if !ok {
		t.Fatalf("rendered config is %T, want map", result.Rendered)
	}
	return rendered
}

func TestNodeTemplateCannotReadPlatformEnv(t *testing.T) {
	dispatcher := (&Engine{}).NewDispatcher(grammar.RenderOptions{})
	for _, name := range []string{
		"JANUSLY_RESUME_TOKEN_SECRET",
		"JANUSLY_CREDENTIAL_MASTER_KEY",
		"DATABASE_URL",
		"ANTHROPIC_API_KEY",
		"WORKOS_API_KEY",
		"AWS_SECRET_ACCESS_KEY",
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "platform-secret-value")
			rendered := renderNodeConfig(t, dispatcher, map[string]any{
				"headers": map[string]any{"x-leak": "{{env." + name + "}}"},
			})
			headers := rendered["headers"].(map[string]any)
			if got := headers["x-leak"]; got != "" {
				t.Fatalf("reserved %s rendered as %q", name, got)
			}
		})
	}
}

func TestNodeTemplateStillReadsTenantEnv(t *testing.T) {
	t.Setenv("ACME_REGION", "us-east-1")
	t.Setenv("JANUSLY_CRED_TENANT_TOKEN", "tenant-owned")
	rendered := renderNodeConfig(t, (&Engine{}).NewDispatcher(grammar.RenderOptions{}), map[string]any{
		"region": "{{env.ACME_REGION}}",
		"token":  "{{env.JANUSLY_CRED_TENANT_TOKEN}}",
	})
	if rendered["region"] != "us-east-1" || rendered["token"] != "tenant-owned" {
		t.Fatalf("tenant env values were not preserved: %+v", rendered)
	}
}

func TestDispatcherPreservesExplicitEnvLookup(t *testing.T) {
	dispatcher := (&Engine{}).NewDispatcher(grammar.RenderOptions{
		LookupEnv: func(string) (string, bool) { return "explicit", true },
	})
	if value, ok := dispatcher.renderOpts.LookupEnv("DATABASE_URL"); !ok || value != "explicit" {
		t.Fatalf("explicit lookup was replaced: %q, %v", value, ok)
	}
}
