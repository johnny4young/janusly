package auth

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/browsersession"
	"github.com/johnny4young/janusly/internal/signedtoken"
	"github.com/johnny4young/janusly/internal/store"
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
	p, err := rv.extract(context.Background(), req)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	return p
}

func TestJanuslySessionRunsFirstAndExposesIdentity(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "auth-session-test-secret")
	browserToken, err := browsersession.CreateToken("session-1", 600)
	if err != nil {
		t.Fatalf("browser token: %v", err)
	}
	full := makeResolver(Config{
		SupabaseURL: "https://sb.example", SupabaseKey: "k",
		ServiceToken: "svc-secret-token",
	})
	full.getActiveSession = func(context.Context, string) (store.AuthSession, error) {
		return store.AuthSession{
			ID: "session-1", UserID: "sso-user", Email: "Alice@Example.com",
			OrgID: "org-sso", ExpiresAt: time.Now().Add(10 * time.Minute),
		}, nil
	}

	p := principalFor(t, full, map[string]string{
		"Cookie": browsersession.CookieName + "=" + browserToken.Value,
		// A fresh browser session must beat a stale-but-valid Supabase JWT.
		"Authorization": "Bearer valid-jwt", "x-org-id": "org-supabase",
	})
	if p == nil || p.providerName != ModeJanuslySession || p.providerUserID != "sso-user" ||
		p.providerOrgHint != "org-sso" || p.declaredSource != SourceSSO || p.browserSessionID != "session-1" {
		t.Fatalf("session precedence: %+v", p)
	}

	req := httptest.NewRequest("GET", "/auth/context", nil)
	req.Header.Set("Cookie", browsersession.CookieName+"="+browserToken.Value)
	identity, err := full.ResolveIdentity(context.Background(), req)
	if err != nil || identity == nil || identity.UserID != "sso-user" ||
		identity.Email != "alice@example.com" || identity.OrgHint != "org-sso" ||
		identity.BrowserSessionID != "session-1" {
		t.Fatalf("identity without membership: %+v %v", identity, err)
	}
}

func TestInvalidSessionFallsThroughButStoreFailureDoesNot(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "auth-session-test-secret")
	full := makeResolver(Config{SupabaseURL: "https://sb.example", SupabaseKey: "k"})

	wrongPurpose, _, err := signedtoken.Sign("sso_state", map[string]string{"sessionId": "session-1"}, 600)
	if err != nil {
		t.Fatalf("wrong-purpose token: %v", err)
	}
	p := principalFor(t, full, map[string]string{
		"Cookie":        browsersession.CookieName + "=" + wrongPurpose,
		"Authorization": "Bearer valid-jwt",
	})
	if p == nil || p.providerName != ModeSupabase {
		t.Fatalf("invalid session must fall through to the next provider: %+v", p)
	}

	valid, err := browsersession.CreateToken("session-1", 600)
	if err != nil {
		t.Fatal(err)
	}
	dbErr := errors.New("session store unavailable")
	full.getActiveSession = func(context.Context, string) (store.AuthSession, error) {
		return store.AuthSession{}, dbErr
	}
	req := httptest.NewRequest("GET", "/auth/context", nil)
	req.Header.Set("Cookie", browsersession.CookieName+"="+valid.Value)
	if _, err := full.ResolveIdentity(context.Background(), req); !errors.Is(err, dbErr) {
		t.Fatalf("store failure must not silently downgrade providers: %v", err)
	}
}

// Chain precedence, implements the contract's priority order.
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
	if p := principalFor(t, dev, map[string]string{
		"x-org-id": "o", "x-user-id": "looks-like@example.com",
	}); p == nil || p.providerUserEmail != "" {
		t.Fatalf("dev headers must not infer a verified email: %+v", p)
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
	if err := (Config{Production: true, SupabaseURL: "https://sb", AllowDevHeaders: true}).BootError(); err == nil {
		t.Fatal("dev headers next to a configured identity provider must refuse to boot in production")
	}
	if err := (Config{SupabaseURL: "https://sb", AllowDevHeaders: true}).BootError(); err != nil {
		t.Fatalf("dev with supabase and dev headers must boot: %v", err)
	}
	if err := (Config{}).BootError(); err != nil {
		t.Fatalf("dev must boot: %v", err)
	}
}
