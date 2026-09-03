package memory

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/johnny4young/janusly/internal/grammar"
)

func TestPrepareMemoryTextScrubsShapesAndExactValues(t *testing.T) {
	const exact = "opaque-runtime-credential-918274"
	const shaped = "sk-ant-abcdefghijklmnopqrstuvwxyz123456"
	input := "use " + exact + " then " + shaped + " at postgres://admin:password@example.test/db"

	safe, reason := prepareMemoryText(input, []string{exact}, "content")
	if reason != "" {
		t.Fatalf("prepare: %s", reason)
	}
	for _, secret := range []string{exact, shaped, "admin:password"} {
		if strings.Contains(safe, secret) {
			t.Fatalf("secret %q survived: %s", secret, safe)
		}
	}
	if strings.Count(safe, grammar.RedactedPlaceholder) != 3 {
		t.Fatalf("expected all three values redacted: %s", safe)
	}
}

func TestPrepareMemoryTextRejectsEmptyAndOversize(t *testing.T) {
	if _, reason := prepareMemoryText(" \n\t", nil, "content"); reason != "content_required" {
		t.Fatalf("empty content reason = %q", reason)
	}
	if _, reason := prepareMemoryText(strings.Repeat("x", memoryTextMaxBytes+1), nil, "query"); reason != "query_too_large" {
		t.Fatalf("oversize query reason = %q", reason)
	}
	if safe, reason := prepareMemoryText(strings.Repeat("é", memoryTextMaxBytes/2), nil, "query"); reason != "" || len(safe) != memoryTextMaxBytes {
		t.Fatalf("exact byte limit rejected or changed: bytes=%d reason=%q", len(safe), reason)
	}
	// The bound applies after sanitization too: a short exact redaction value
	// can expand into the longer placeholder many times.
	if _, reason := prepareMemoryText(strings.Repeat("x", memoryTextMaxBytes), []string{"x"}, "content"); reason != "content_too_large" {
		t.Fatalf("post-redaction expansion reason = %q", reason)
	}
}

func TestSafeMemoryMetadataScrubsBoundsAndDoesNotMutate(t *testing.T) {
	const exact = "opaque-metadata-secret-918274"
	metadata := map[string]any{
		"token": exact,
		"nested": map[string]any{
			"note": "Bearer abcdefghijklmnopqrstuvwxyz and " + exact,
			"blob": strings.Repeat("x", memoryMetadataMaxBytes*2),
		},
	}
	raw := safeMemoryMetadata(metadata, []string{exact})
	if !json.Valid(raw) || len(raw) > memoryMetadataMaxBytes {
		t.Fatalf("metadata must be valid bounded JSON: bytes=%d raw=%q", len(raw), raw)
	}
	if strings.Contains(string(raw), exact) || strings.Contains(string(raw), "abcdefghijklmnopqrstuvwxyz") {
		t.Fatalf("metadata leaked a secret: %s", raw)
	}
	if !strings.Contains(string(raw), `"__truncated":true`) {
		t.Fatalf("oversize metadata must use the bounded sentinel: %s", raw)
	}
	if metadata["token"] != exact || !strings.Contains(metadata["nested"].(map[string]any)["note"].(string), exact) {
		t.Fatal("sanitization mutated caller metadata")
	}
}

func TestSafeMemoryMetadataRejectsPathologicalInputWithoutPreview(t *testing.T) {
	secret := "sk-ant-abcdefghijklmnopqrstuvwxyz123456"
	raw := safeMemoryMetadata(map[string]any{
		"note": secret + strings.Repeat("x", memoryMetadataScanMaxBytes),
	}, nil)
	if string(raw) != `{"__truncated":true}` || strings.Contains(string(raw), secret) {
		t.Fatalf("pathological metadata must become a preview-free sentinel: %s", raw)
	}
}

func TestEmbeddingConfigDoesNotAcceptUnsupportedProvider(t *testing.T) {
	config := operationConfig{
		// A stale row from an earlier development baseline must remain inert.
		"memory.embeddingProvider": {Value: "openai", Source: "tenant"},
		"memory.embeddingModel":    {Value: "bge-m3", Source: "tenant"},
		"memory.embeddingBaseUrl":  {Value: "https://embeddings.example", Source: "tenant"},
	}
	provider, model, baseURL, tenantURL := config.embeddingConfig()
	if provider != "ollama" || model != "bge-m3" || baseURL != "https://embeddings.example" || !tenantURL {
		t.Fatalf("embedding config = %q %q %q %v", provider, model, baseURL, tenantURL)
	}
	if _, exists := config["memory.embeddingProvider"]; !exists {
		t.Fatal("test setup must include the stale selector")
	}
}

func TestEmbeddingConfigDoesNotReReadRejectedEnvironmentValue(t *testing.T) {
	t.Setenv("OLLAMA_BASE_URL", "https://user:password@attacker.example")
	config := operationConfig{
		"memory.embeddingModel":   {Value: "", Source: "default"},
		"memory.embeddingBaseUrl": {Value: "", Source: "default"},
	}
	_, model, baseURL, tenantURL := config.embeddingConfig()
	if model != "bge-m3" || baseURL != "http://ollama:11434" || tenantURL {
		t.Fatalf("rejected env value re-entered runtime config: model=%q url=%q tenant=%v", model, baseURL, tenantURL)
	}
}

func TestEmbeddingEndpointUsesStructuredBaseURL(t *testing.T) {
	endpoint, err := embeddingEndpoint("https://embeddings.example/ollama/")
	if err != nil || endpoint != "https://embeddings.example/ollama/api/embeddings" {
		t.Fatalf("endpoint = %q err=%v", endpoint, err)
	}
	for _, invalid := range []string{
		"https://user:pass@embeddings.example", "https://embeddings.example?path=/other",
		"file:///tmp/ollama", strings.Repeat("x", embeddingBaseURLMaxBytes+1),
	} {
		if endpoint, err := embeddingEndpoint(invalid); err == nil || endpoint != "" {
			t.Fatalf("invalid base URL accepted: endpoint=%q err=%v", endpoint, err)
		}
	}
}

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

func TestValidateEmbeddingRejectsUnsafePgvectorValues(t *testing.T) {
	valid := make([]float64, embeddingDimension)
	valid[0] = 0.25
	if err := validateEmbedding(valid); err != nil {
		t.Fatalf("valid vector rejected: %v", err)
	}

	for name, mutate := range map[string]func([]float64){
		"zero":                      func(_ []float64) {},
		"non-finite":                func(vector []float64) { vector[0] = math.Inf(1) },
		"float32 overflow":          func(vector []float64) { vector[0] = math.MaxFloat64 },
		"float32 underflow to zero": func(vector []float64) { vector[0] = math.SmallestNonzeroFloat64 },
	} {
		t.Run(name, func(t *testing.T) {
			vector := make([]float64, embeddingDimension)
			mutate(vector)
			if err := validateEmbedding(vector); err == nil {
				t.Fatal("unsafe vector must be rejected")
			}
		})
	}
	if err := validateEmbedding(make([]float64, embeddingDimension-1)); err == nil {
		t.Fatal("wrong-dimensional vector must be rejected")
	}
}

func TestEmbedNeverReplaysMemoryTextAcrossRedirect(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	var received atomic.Int32
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received.Add(1)
		_, _ = w.Write([]byte(`{"embedding":[]}`))
	}))
	t.Cleanup(receiver.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, receiver.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)

	for _, tenantURL := range []bool{false, true} {
		if _, err := embed(context.Background(), redirector.URL, "model", "private memory text", tenantURL); err == nil {
			t.Fatalf("redirect must fail for tenantURL=%v", tenantURL)
		}
	}
	if received.Load() != 0 {
		t.Fatalf("redirect receiver observed %d replayed request(s)", received.Load())
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
