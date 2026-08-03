package secretstore

import "testing"

// The escalation this closes: an org admin points a credential at the
// platform's own configuration and the runtime resolves it.
func TestReservedEnvNamesAreNeverReferenceable(t *testing.T) {
	t.Setenv(AllowlistEnv, "")
	for _, name := range []string{
		"JANUSLY_API_SERVICE_TOKEN", "JANUSLY_CREDENTIAL_MASTER_KEY",
		"JANUSLY_CREDENTIAL_MASTER_KEY_FILE", "JANUSLY_DATABASE_URL",
		"JANUSLY_RESUME_TOKEN_SECRET", "JANUSLY_ADMIN_TOKEN",
		"SUPABASE_SERVICE_ROLE_KEY", "WORKOS_API_KEY",
		"AWS_SECRET_ACCESS_KEY", "ALLOW_DEV_AUTH_HEADERS",
		"DATABASE_URL", "ANTHROPIC_API_KEY", "PATH", "NODE_ENV",
	} {
		if EnvRefAllowed(name) {
			t.Errorf("%s must never be referenceable by a tenant credential", name)
		}
	}
	// A variable this process does not own stays usable, so an existing
	// deployment keeps working without an allowlist.
	for _, name := range []string{"ACME_PARTNER_TOKEN", "STRIPE_KEY", "JANUSLY_CRED_STRIPE"} {
		if !EnvRefAllowed(name) {
			t.Errorf("%s is an ordinary tenant credential and must resolve", name)
		}
	}
	if EnvRefAllowed("") || EnvRefAllowed("   ") {
		t.Error("an empty reference must never resolve")
	}
}

// A configured allowlist is the COMPLETE set of referenceable names.
func TestAllowlistIsExhaustiveWhenConfigured(t *testing.T) {
	t.Setenv(AllowlistEnv, " ACME_PARTNER_TOKEN , PARTNER_* ")
	if !EnvRefAllowed("ACME_PARTNER_TOKEN") {
		t.Error("an exact allowlist entry must resolve")
	}
	if !EnvRefAllowed("PARTNER_STRIPE") || !EnvRefAllowed("PARTNER_") {
		t.Error("a prefix glob must resolve its namespace")
	}
	if EnvRefAllowed("STRIPE_KEY") {
		t.Error("a name outside a configured allowlist must be refused")
	}
	// Reserved wins over the allowlist: allowlisting the service token
	// must not make it referenceable.
	t.Setenv(AllowlistEnv, "JANUSLY_API_SERVICE_TOKEN,*")
	if EnvRefAllowed("JANUSLY_API_SERVICE_TOKEN") {
		t.Error("the reserved namespace must outrank the allowlist")
	}
	// The sanctioned carve-out still works inside the platform namespace.
	if !EnvRefAllowed("JANUSLY_CRED_STRIPE") {
		t.Error("the tenant-credential prefix must remain usable")
	}
}
