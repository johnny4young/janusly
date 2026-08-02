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

	if _, err := embed(context.Background(), server.URL, "model", "prompt"); err == nil {
		t.Fatal("oversized embedding response must fail")
	}
}
