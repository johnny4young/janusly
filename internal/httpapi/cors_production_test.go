package httpapi

import "testing"

// The "*" origin is a development convenience. It must be refused under every
// spelling of production that the boot gate accepts, or the wildcard rides
// alongside Access-Control-Allow-Credentials in a deployment that believes it
// is gated.
func TestWildcardOriginRefusedUnderEveryProductionSpelling(t *testing.T) {
	t.Setenv("API_ALLOWED_ORIGINS", "*")
	for _, value := range []string{"production", "Production", " production "} {
		t.Setenv("JANUSLY_ENV", value)
		if isAllowedRequestOrigin("https://attacker.example") {
			t.Fatalf("JANUSLY_ENV=%q must refuse the wildcard origin", value)
		}
	}
	t.Setenv("JANUSLY_ENV", "development")
	if !isAllowedRequestOrigin("https://attacker.example") {
		t.Fatal("development keeps the wildcard convenience")
	}
}
