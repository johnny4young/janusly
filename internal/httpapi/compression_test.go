package httpapi

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	contractdoc "github.com/johnny4young/janusly/contract"
)

func TestOpenAPIServesGzipWhenAccepted(t *testing.T) {
	handler := WithBrowserHeaders(http.HandlerFunc(serveOpenAPI))
	get := func(headers map[string]string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("GET", "/v1/openapi.json", nil)
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	compressed := get(map[string]string{"Accept-Encoding": "gzip, br"})
	if compressed.Code != 200 || compressed.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("compressed: %d %q", compressed.Code, compressed.Header().Get("Content-Encoding"))
	}
	if vary := compressed.Header().Values("Vary"); len(vary) != 2 || vary[0] != "Origin" || vary[1] != "Accept-Encoding" {
		t.Fatalf("vary: %v", vary)
	}
	reader, err := gzip.NewReader(compressed.Body)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := io.ReadAll(reader)
	if !bytes.Equal(decoded, contractdoc.OpenAPI) || compressed.Body.Len() != 0 {
		t.Fatal("gzip body must decode to the embedded contract")
	}
	if compressed.Header().Get("Content-Length") == "" {
		t.Fatal("gzip body must declare its length")
	}

	plain := get(nil)
	if plain.Code != 200 || plain.Header().Get("Content-Encoding") != "" || !bytes.Equal(plain.Body.Bytes(), contractdoc.OpenAPI) {
		t.Fatalf("identity: %d %q", plain.Code, plain.Header().Get("Content-Encoding"))
	}
	if plain.Header().Get("ETag") == compressed.Header().Get("ETag") {
		t.Fatal("identity and gzip need distinct ETags")
	}
	if again := get(map[string]string{"Accept-Encoding": "gzip", "If-None-Match": compressed.Header().Get("ETag")}); again.Code != 304 {
		t.Fatalf("revalidation: %d", again.Code)
	}
}

// Dynamic API bodies are never compressed, so SSE frames still reach the
// client one flush at a time through the production middleware chain.
func TestEventStreamStaysUncompressedAndFlushes(t *testing.T) {
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /stream", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "data: second\n\n")
	})
	server := httptest.NewServer(WithBrowserHeaders(withRequestTelemetry(mux, slog.New(slog.DiscardHandler))))
	defer server.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()

	request, _ := http.NewRequest("GET", server.URL+"/stream", nil)
	request.Header.Set("Accept-Encoding", "gzip, deflate, br")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" {
		t.Fatalf("event stream must not be encoded, got %q", encoding)
	}
	lines := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(response.Body).ReadString('\n')
		lines <- line
	}()
	select {
	case line := <-lines:
		if strings.TrimSpace(line) != "data: first" {
			t.Fatalf("first frame: %q", line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first frame was buffered instead of flushed")
	}
	close(release)
}
