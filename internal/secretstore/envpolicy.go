// Which process environment variables a tenant credential may reference.
//
// A credential's secretRef either names a managed row
// (janusly-secret://<uuid>) or, through the documented legacy provider,
// an environment variable read straight off THIS process. Nothing used
// to restrict which variable — so an organization admin, a role that is
// self-service in every tenant, could point a credential at the
// platform's own configuration and have the runtime resolve it. From
// there the value only has to surface once (an upstream error quoting a
// malformed DSN, a future tool that forwards it) to hand out the service
// token, the credential master key, or the database URL: a single-tenant
// admin escalating to the whole platform.
//
// Two layers, both fail-closed:
//
//  1. A RESERVED namespace that is never resolvable, derived from the
//     prefixes this process reads for its own configuration. Prefix-based
//     on purpose: an exact blocklist silently rots the day someone adds
//     JANUSLY_NEW_SECRET, while a prefix covers it on arrival.
//  2. An operator ALLOWLIST (JANUSLY_CREDENTIAL_ENV_ALLOWLIST). When set,
//     it is the complete set of referenceable names — anything outside is
//     refused even if it is not reserved.
//
// Reserved always wins: allowlisting JANUSLY_API_SERVICE_TOKEN does not
// make it referenceable, because it is never a legitimate tenant secret.
// Operators who deliberately keep tenant credential material in the
// platform namespace have one carve-out, the JANUSLY_CRED_ prefix.
package secretstore

import (
	"os"
	"strings"
)

const (
	// AllowlistEnv names the operator allowlist. Comma-separated exact
	// names and PREFIX_* globs; empty means "reserved namespace only".
	AllowlistEnv = "JANUSLY_CREDENTIAL_ENV_ALLOWLIST"
	// TenantCredentialPrefix is the sanctioned way to keep a tenant
	// credential inside the platform's own namespace.
	TenantCredentialPrefix = "JANUSLY_CRED_"
)

// reservedEnvPrefixes cover every namespace this process reads for its
// own configuration and secrets, plus the namespaces managed platforms
// inject into the process (Railway, Render, Fly.io, Heroku, PostgreSQL
// client variables): a tenant credential must never resolve the
// platform's own configuration.
var reservedEnvPrefixes = []string{
	"JANUSLY_", "SUPABASE_", "WORKOS_", "AWS_", "OTEL_", "ALLOW_",
	"PG", "POSTGRES_", "RAILWAY_", "RENDER_", "FLY_", "HEROKU_", "NIXPACKS_",
}

// reservedEnvNames are the unprefixed variables that still carry
// platform authority or provider credentials.
var reservedEnvNames = map[string]bool{
	"PATH": true, "HOME": true, "NODE_ENV": true,
	"DATABASE_URL": true, "REDIS_URL": true,
	"ANTHROPIC_API_KEY": true, "OPENAI_API_KEY": true,
	"RESEND_API_KEY": true, "SENDGRID_API_KEY": true,
	"OLLAMA_BASE_URL": true, "API_ALLOWED_ORIGINS": true,
	"PORT": true, "DYNO": true,
}

// EnvRefAllowed reports whether a legacy secretRef may be resolved.
func EnvRefAllowed(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return false
	}
	if isReservedEnvName(name) {
		return false
	}
	allowlist := parseAllowlist(os.Getenv(AllowlistEnv))
	if len(allowlist) == 0 {
		// No allowlist configured: the reserved namespace is the floor, so
		// the escalation path is closed without breaking a deployment that
		// already references ordinary variables.
		return true
	}
	return matchesAllowlist(name, allowlist)
}

// LookupAllowedEnv adapts the credential environment policy to template
// renderers. Refused names look exactly like unset variables so the boundary
// does not become an oracle for platform configuration.
func LookupAllowedEnv(name string) (string, bool) {
	if !EnvRefAllowed(name) {
		return "", false
	}
	return os.LookupEnv(name)
}

func isReservedEnvName(name string) bool {
	if strings.HasPrefix(name, TenantCredentialPrefix) {
		return false
	}
	if reservedEnvNames[name] {
		return true
	}
	for _, prefix := range reservedEnvPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func parseAllowlist(raw string) []string {
	entries := make([]string, 0, strings.Count(raw, ",")+1)
	for entry := range strings.SplitSeq(raw, ",") {
		if trimmed := strings.TrimSpace(entry); trimmed != "" {
			entries = append(entries, trimmed)
		}
	}
	return entries
}

func matchesAllowlist(name string, allowlist []string) bool {
	for _, entry := range allowlist {
		if prefix, found := strings.CutSuffix(entry, "*"); found {
			if strings.HasPrefix(name, prefix) {
				return true
			}
			continue
		}
		if entry == name {
			return true
		}
	}
	return false
}
