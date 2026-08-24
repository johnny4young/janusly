package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The browser policy implements the contract: conditional origin echo,
// bounded header lists, browser hardening, 204 preflights, inbound request-id honored.

func corsProbe(t *testing.T, method, origin, requestID string) *httptest.ResponseRecorder {
	t.Helper()
	handler := WithBrowserHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	req := httptest.NewRequest(method, "/v1/runs", nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if requestID != "" {
		req.Header.Set("x-request-id", requestID)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestPreflightAnswers204WithTheFullDict(t *testing.T) {
	rec := corsProbe(t, http.MethodOptions, "http://localhost:5173", "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status: %d", rec.Code)
	}
	h := rec.Header()
	if h.Get("Access-Control-Allow-Origin") != "http://localhost:5173" ||
		h.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("allowlisted origin must echo with credentials: %v", h)
	}
	if h.Get("Access-Control-Allow-Methods") != "GET,POST,PUT,DELETE,OPTIONS" {
		t.Fatalf("methods list consistency: %q", h.Get("Access-Control-Allow-Methods"))
	}
	if h.Get("Access-Control-Allow-Headers") !=
		"Content-Type, Authorization, x-org-id, x-user-id, x-janusly-csrf, x-request-id, Accept-Language, Last-Event-ID" {
		t.Fatalf("headers list consistency: %q", h.Get("Access-Control-Allow-Headers"))
	}
	if h.Get("Access-Control-Expose-Headers") != "Content-Disposition, X-Request-Id" ||
		h.Get("Vary") != "Origin" {
		t.Fatalf("expose/vary consistency: %v", h)
	}
}

func TestBrowserSecurityHeadersAreAlwaysPresent(t *testing.T) {
	h := corsProbe(t, http.MethodGet, "", "").Header()
	for name, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
		"Permissions-Policy":     "camera=(), microphone=(), geolocation=()",
	} {
		if got := h.Get(name); got != want {
			t.Errorf("%s: got %q want %q", name, got, want)
		}
	}
	if got := h.Get("Content-Security-Policy"); got == "" {
		t.Fatal("browser responses must carry a content security policy")
	}
}

func TestDisallowedOriginNeverEchoes(t *testing.T) {
	rec := corsProbe(t, http.MethodGet, "https://evil.example", "")
	h := rec.Header()
	if h.Get("Access-Control-Allow-Origin") != "" || h.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("disallowed origin must not echo: %v", h)
	}
	// The fixed lists and Vary still ship — caches must not poison.
	if h.Get("Access-Control-Allow-Methods") == "" || h.Get("Vary") != "Origin" {
		t.Fatalf("fixed headers must remain: %v", h)
	}
}

func TestWildcardOriginIsDisabledInProduction(t *testing.T) {
	t.Setenv("API_ALLOWED_ORIGINS", "*")
	t.Setenv("JANUSLY_ENV", "")
	if got := corsProbe(t, http.MethodGet, "https://preview.example", "").Header().Get("Access-Control-Allow-Origin"); got == "" {
		t.Fatal("development wildcard must retain reference compatibility")
	}

	t.Setenv("JANUSLY_ENV", "production")
	h := corsProbe(t, http.MethodGet, "https://attacker.example", "").Header()
	if h.Get("Access-Control-Allow-Origin") != "" || h.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("credentialed production CORS must require a concrete origin: %v", h)
	}
}

func TestInboundRequestIDIsHonored(t *testing.T) {
	rec := corsProbe(t, http.MethodGet, "", "trace-abc-123")
	if rec.Header().Get("X-Request-Id") != "trace-abc-123" {
		t.Fatalf("valid inbound id must round-trip: %q", rec.Header().Get("X-Request-Id"))
	}
	// A hostile id (too long / bad charset) is replaced, never echoed.
	hostile := corsProbe(t, http.MethodGet, "", "abc\r\nSet-Cookie: pwned")
	if got := hostile.Header().Get("X-Request-Id"); got == "" || len(got) != 36 {
		t.Fatalf("hostile id must be replaced by a uuid: %q", got)
	}
}
