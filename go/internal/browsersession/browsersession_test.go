package browsersession

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpaqueSessionTokenRoundTrip(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "browser-session-test-secret")
	token, err := CreateToken("session-1", 600)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	req := httptest.NewRequest("GET", "/auth/session", nil)
	req.Header.Set("Cookie", "other=x; "+CookieName+"="+token.Value)
	if got := ReadSessionID(req); got != "session-1" {
		t.Fatalf("opaque id round trip: %q", got)
	}

	parts := strings.Split(token.Value, ".")
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("json: %v", err)
	}
	encoded := string(raw)
	if strings.Contains(encoded, "email") || strings.Contains(encoded, "orgId") {
		t.Fatalf("cookie token must carry only an opaque id: %s", encoded)
	}
	if payload, ok := envelope["payload"].(map[string]any); !ok || payload["sessionId"] != "session-1" {
		t.Fatalf("payload: %+v", envelope)
	}

	req.Header.Set("Cookie", CookieName+"="+token.Value[:len(token.Value)-1]+"x")
	if got := ReadSessionID(req); got != "" {
		t.Fatalf("tampered cookie must be anonymous: %q", got)
	}
}

func TestSessionCookieAttributesAndSecurePolicy(t *testing.T) {
	t.Setenv("JANUSLY_SESSION_COOKIE_SECURE", "")
	t.Setenv("JANUSLY_WEB_BASE_URL", "http://localhost:7310")
	local := SessionCookie("token", 600)
	for _, part := range []string{"janusly_session=token", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=600"} {
		if !strings.Contains(local, part) {
			t.Fatalf("cookie missing %q: %s", part, local)
		}
	}
	if strings.Contains(local, "Secure") {
		t.Fatalf("http cookie must not be Secure: %s", local)
	}

	t.Setenv("JANUSLY_WEB_BASE_URL", "https://janusly.example.com")
	if got := SessionCookie("token", 600); !strings.Contains(got, "; Secure") {
		t.Fatalf("https cookie must be Secure: %s", got)
	}
	t.Setenv("JANUSLY_SESSION_COOKIE_SECURE", "false")
	if got := SessionCookie("token", 600); strings.Contains(got, "Secure") {
		t.Fatalf("explicit false must win: %s", got)
	}
	if got := ClearCookie(); !strings.Contains(got, "Max-Age=0") {
		t.Fatalf("clear cookie: %s", got)
	}
}

func TestCSRFRequiresMarkerAndAllowedOrigin(t *testing.T) {
	allowed := func(origin string) bool { return origin == "https://janusly.example.com" }
	req := httptest.NewRequest("POST", "/auth/session/logout", nil)
	req.Header.Set("Origin", "https://janusly.example.com")
	req.Header.Set(CSRFHeader, "1")
	if err := RequireCSRF(req, allowed); err != nil {
		t.Fatalf("allowlisted request: %v", err)
	}

	for name, mutate := range map[string]func(*http.Request){
		"missing marker": func(r *http.Request) { r.Header.Del(CSRFHeader) },
		"foreign origin": func(r *http.Request) { r.Header.Set("Origin", "https://attacker.example") },
	} {
		t.Run(name, func(t *testing.T) {
			probe := req.Clone(req.Context())
			probe.Header = req.Header.Clone()
			mutate(probe)
			if err := RequireCSRF(probe, allowed); !errors.Is(err, ErrInvalidCSRF) {
				t.Fatalf("must fail uniformly: %v", err)
			}
		})
	}
	if err := RequireCSRF(req, nil); !errors.Is(err, ErrInvalidCSRF) {
		t.Fatalf("missing origin policy must fail closed: %v", err)
	}
}
