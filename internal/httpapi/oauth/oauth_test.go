package oauth

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

func TestRedirectRules(t *testing.T) {
	for redirect, ok := range map[string]bool{
		"https://app.example.com/cb": true, "http://127.0.0.1:8123/cb": true, "http://localhost/cb": true, "http://[::1]:9/cb": true,
		"http://app.example.com/cb": false, "http://localhost.evil.com/cb": false, "http://127.0.0.1.nip.io/cb": false,
		"https://user:pw@app.example.com/cb": false, "https://app.example.com/cb#frag": false, "cursor://x/cb": false,
		"javascript:alert(1)": false, "/relative": false, "": false, "https:///nohost": false,
		"https://app.example.com/" + strings.Repeat("a", 2000): false,
	} {
		if validRedirect(redirect) != ok {
			t.Fatalf("validRedirect(%q) != %v", redirect, ok)
		}
	}
	registered := []string{"https://app.example.com/cb", "http://127.0.0.1/callback"}
	for presented, ok := range map[string]bool{
		"https://app.example.com/cb": true, "http://127.0.0.1:53211/callback": true, "http://127.0.0.1/callback": true,
		"https://app.example.com/cb/": false, "https://app.example.com/cb?x=1": false, "https://app.example.com:444/cb": false,
		"https://evil.example.com/cb": false, "http://127.0.0.1:53211/other": false, "http://localhost:53211/callback": false,
		"http://127.0.0.1:53211/callback?next=evil": false, "https://APP.example.com/cb": false,
	} {
		if redirectMatches(registered, presented) != ok {
			t.Fatalf("redirectMatches(%q) != %v", presented, ok)
		}
	}
}

func TestScopesNeverCarryReport(t *testing.T) {
	if got, ok := parseScopes(""); !ok || strings.Join(got, ",") != "read" {
		t.Fatalf("default scope: %v %v", got, ok)
	}
	if got, ok := parseScopes("janusly:operate janusly:propose janusly:operate"); !ok || strings.Join(got, ",") != "read,operate,propose" {
		t.Fatalf("scopes: %v %v", got, ok)
	}
	for _, scope := range []string{"janusly:report", "janusly:admin", "read", "janusly:read openid"} {
		if _, ok := parseScopes(scope); ok {
			t.Fatalf("accepted scope %q", scope)
		}
	}
	if scopeString([]string{"read", "report", "publish"}) != "janusly:read janusly:publish" {
		t.Fatal("scope string leaked report")
	}
}

func TestPKCE(t *testing.T) {
	verifier := strings.Repeat("v", 43)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	if !pkceMatches(verifier, challenge) || pkceMatches(strings.Repeat("w", 43), challenge) ||
		pkceMatches("short", challenge) || pkceMatches(verifier+"!", challenge) || pkceMatches(strings.Repeat("v", 129), challenge) {
		t.Fatal("pkce")
	}
}

func TestClientNameIsPrintable(t *testing.T) {
	if clientName("  Claude\u202e Code\n") != "Claude Code" || clientName("") != "MCP client" || len([]rune(clientName(strings.Repeat("x", 300)))) != 100 {
		t.Fatalf("clientName: %q", clientName("  Claude\u202e Code\n"))
	}
}
