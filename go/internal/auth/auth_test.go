package auth

import (
	"context"
	"net/http/httptest"
	"testing"
)

func makeResolver(cfg Config) *Resolver {
	// nil pool: these tests exercise extraction only (no membership reads).
	r := NewResolver(nil, cfg)
	r.verifySupabase = func(_ context.Context, token string) (string, string, bool) {
		if token == "valid-jwt" {
			return "user-uuid-1", "ada@example.com", true
		}
		return "", "", false
	}
	return r
}

func principalFor(t *testing.T, rv *Resolver, headers map[string]string) *principal {
	t.Helper()
	req := httptest.NewRequest("GET", "/v1/runs", nil)
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	return rv.extract(context.Background(), req)
}

// Chain precedence, ported from the reference's priority order.
func TestProviderChainPrecedence(t *testing.T) {
	full := makeResolver(Config{
		SupabaseURL: "https://sb.example", SupabaseKey: "k",
		ServiceToken: "svc-secret-token",
	})

	// A valid Supabase JWT wins and hardcodes source web even when the
	// caller self-declares MCP.
	p := principalFor(t, full, map[string]string{
		"Authorization": "Bearer valid-jwt", "x-org-id": "org-a",
		"x-janusly-source": "mcp",
	})
	if p == nil || p.providerName != ModeSupabase || p.declaredSource != SourceWeb {
		t.Fatalf("supabase precedence: %+v", p)
	}

	// A Bearer that fails verification NEVER falls through to dev headers.
	if p := principalFor(t, full, map[string]string{
		"Authorization": "Bearer forged", "x-org-id": "org-a", "x-user-id": "u1",
	}); p != nil {
		t.Fatalf("failed bearer must not fall through: %+v", p)
	}

	// The service token routes to service-token mode with the suffix, and
	// honors the MCP self-declaration.
	p = principalFor(t, full, map[string]string{
		"Authorization": "Bearer svc-secret-token", "x-org-id": "org-b",
		"x-user-id": "bot", "x-janusly-source": "mcp",
	})
	if p == nil || p.providerName != ModeServiceToken || p.declaredSource != SourceMcp ||
		p.serviceTokenSuffix != "oken" {
		t.Fatalf("service token: %+v", p)
	}

	// Missing user header collapses to the service account label.
	p = principalFor(t, full, map[string]string{
		"Authorization": "Bearer svc-secret-token", "x-org-id": "org-b",
	})
	if p == nil || p.providerUserID != "service" {
		t.Fatalf("service account collapse: %+v", p)
	}
}

func TestDevHeadersGate(t *testing.T) {
	// Dev headers auto-allowed only without Supabase outside production.
	dev := makeResolver(Config{})
	if p := principalFor(t, dev, map[string]string{"x-org-id": "o", "x-user-id": "u"}); p == nil ||
		p.providerName != ModeDevHeaders {
		t.Fatalf("dev auto-allow: %+v", p)
	}

	// Production without the explicit override: no dev headers.
	prod := makeResolver(Config{Production: true, AllowDevHeaders: false, SupabaseURL: "https://sb", SupabaseKey: "k"})
	if p := principalFor(t, prod, map[string]string{"x-org-id": "o", "x-user-id": "u"}); p != nil {
		t.Fatalf("production must not accept dev headers: %+v", p)
	}

	// Explicit override re-enables them.
	override := makeResolver(Config{Production: true, AllowDevHeaders: true})
	if p := principalFor(t, override, map[string]string{"x-org-id": "o", "x-user-id": "u"}); p == nil {
		t.Fatal("explicit override must allow dev headers")
	}
}

func TestBootGate(t *testing.T) {
	if err := (Config{Production: true}).BootError(); err == nil {
		t.Fatal("production without Supabase must refuse to boot")
	}
	if err := (Config{Production: true, AllowDevHeaders: true}).BootError(); err != nil {
		t.Fatalf("explicit override must boot: %v", err)
	}
	if err := (Config{Production: true, SupabaseURL: "https://sb"}).BootError(); err != nil {
		t.Fatalf("supabase-configured production must boot: %v", err)
	}
	if err := (Config{}).BootError(); err != nil {
		t.Fatalf("dev must boot: %v", err)
	}
}
