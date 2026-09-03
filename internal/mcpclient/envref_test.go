package mcpclient

import "testing"

func TestLookupEnvRefRefusesReservedNames(t *testing.T) {
	t.Setenv("JANUSLY_API_SERVICE_TOKEN", "platform-secret")
	value, reason := lookupEnvRef("JANUSLY_API_SERVICE_TOKEN")
	if value != "" || reason != "credential secret missing" {
		t.Fatalf("reserved variable resolved as %q / %q", value, reason)
	}
}

func TestLookupEnvRefStillResolvesOrdinaryNames(t *testing.T) {
	t.Setenv("VENDOR_MCP_TOKEN", "vendor-value")
	value, reason := lookupEnvRef("VENDOR_MCP_TOKEN")
	if value != "vendor-value" || reason != "" {
		t.Fatalf("ordinary variable resolved as %q / %q", value, reason)
	}
}

func TestLookupEnvRefStillRejectsCRLF(t *testing.T) {
	t.Setenv("VENDOR_MCP_TOKEN", "ok\r\nX-Injected: yes")
	if _, reason := lookupEnvRef("VENDOR_MCP_TOKEN"); reason != "credential value invalid" {
		t.Fatalf("CRLF refusal = %q", reason)
	}
}
