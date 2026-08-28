package main

import (
	"net/url"
	"os"
	"testing"
)

func TestAdminTokenPrecedence(t *testing.T) {
	t.Setenv("JANUSLY_API_SERVICE_TOKEN", "server-token")
	t.Setenv("JANUSLY_ADMIN_TOKEN", "")
	if got := envOr("JANUSLY_ADMIN_TOKEN", os.Getenv("JANUSLY_API_SERVICE_TOKEN")); got != "server-token" {
		t.Fatalf("fallback token = %q", got)
	}
	t.Setenv("JANUSLY_ADMIN_TOKEN", "dedicated-token")
	if got := envOr("JANUSLY_ADMIN_TOKEN", os.Getenv("JANUSLY_API_SERVICE_TOKEN")); got != "dedicated-token" {
		t.Fatalf("dedicated token = %q", got)
	}
}

func TestAdminQueryEncoding(t *testing.T) {
	got := withQuery("/v1/run", url.Values{"runId": {"run/one & two"}})
	if got != "/v1/run?runId=run%2Fone+%26+two" {
		t.Fatalf("query = %q", got)
	}
}
