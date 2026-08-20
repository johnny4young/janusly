package memory

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmbedRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"embedding":[],"padding":"` +
			strings.Repeat("x", embeddingResponseMaxBytes) + `"}`))
	}))
	t.Cleanup(server.Close)

	if _, err := embed(context.Background(), server.URL, "model", "prompt", false); err == nil {
		t.Fatal("oversized embedding response must fail")
	}
}

// A tenant-supplied (org-config) base URL is org-admin input: without the
// dev escape hatch it must pass the outbound SSRF policy, so a loopback
// target is refused before any request is issued.
func TestEmbedEnforcesSSRFPolicyForTenantURLs(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "false")
	requested := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requested = true
		_, _ = w.Write([]byte(`{"embedding":[]}`))
	}))
	t.Cleanup(server.Close)

	_, err := embed(context.Background(), server.URL, "model", "prompt", true)
	if err == nil {
		t.Fatal("tenant-supplied loopback embedding URL must be refused")
	}
	if requested {
		t.Fatal("the refused target must never receive a request")
	}
}
