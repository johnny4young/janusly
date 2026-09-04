package auth

import "testing"

// JANUSLY_ENV is the ONLY production gate (CLAUDE.md). Every reader must agree
// on what counts as production: a value the boot gates accept as production
// must also be production here, or forgeable dev headers stay enabled behind a
// deployment that looks fully gated.
func TestConfigFromEnvResolvesProductionLikeTheBootGate(t *testing.T) {
	for _, value := range []string{"production", "Production", "PRODUCTION", " production ", "production\t"} {
		t.Setenv("JANUSLY_ENV", value)
		if !ConfigFromEnv().Production {
			t.Fatalf("JANUSLY_ENV=%q must be production for auth, as it is for boot", value)
		}
	}
	for _, value := range []string{"", "prod", "development", "staging", "production-eu"} {
		t.Setenv("JANUSLY_ENV", value)
		if ConfigFromEnv().Production {
			t.Fatalf("JANUSLY_ENV=%q must not be production", value)
		}
	}
}

// The consequence that matters: no variant of "production" may leave the
// dev-header path open when Supabase is unset.
func TestProductionVariantsNeverAllowDevHeaders(t *testing.T) {
	for _, value := range []string{"Production", "production "} {
		t.Setenv("JANUSLY_ENV", value)
		t.Setenv("SUPABASE_URL", "")
		t.Setenv("ALLOW_DEV_AUTH_HEADERS", "")
		cfg := ConfigFromEnv()
		if cfg.AllowDevHeaders || (cfg.SupabaseURL == "" && !cfg.Production) {
			t.Fatalf("JANUSLY_ENV=%q would allow dev headers", value)
		}
		if err := cfg.BootError(); err == nil {
			t.Fatalf("JANUSLY_ENV=%q without Supabase must fail boot", value)
		}
	}
}
