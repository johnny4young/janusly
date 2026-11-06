package webdist

import (
	"io"
	"mime"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// Exact files serve with the right cache posture; everything else
// falls back to index.html (SPA client routes).
func TestHandlerServingContract(t *testing.T) {
	dist := fstest.MapFS{
		"index.html":               {Data: []byte("<html>app shell</html>")},
		"logo.svg":                 {Data: []byte("<svg/>")},
		"assets/app-abc123.js":     {Data: []byte("console.log(1)")},
		"assets/app-abc123.css":    {Data: []byte("body{}")},
		"assets/font-abc123.woff2": {Data: []byte("wOF2\x00\x01\x00\x00")},
	}
	handler := HandlerFor(dist)
	get := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", path, nil))
		return recorder
	}

	root := get("/")
	if root.Code != 200 || root.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("root: %d %q", root.Code, root.Header().Get("Cache-Control"))
	}
	if body, _ := io.ReadAll(root.Body); string(body) != "<html>app shell</html>" {
		t.Fatalf("root body: %s", body)
	}

	asset := get("/assets/app-abc123.js")
	if asset.Code != 200 || asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset caching: %d %q", asset.Code, asset.Header().Get("Cache-Control"))
	}

	font := get("/assets/font-abc123.woff2")
	if font.Code != 200 || font.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || font.Header().Get("Content-Type") != "font/woff2" {
		t.Fatalf("font: %d %q %q", font.Code, font.Header().Get("Cache-Control"), font.Header().Get("Content-Type"))
	}

	spa := get("/flows/wf-123/runs")
	if spa.Code != 200 {
		t.Fatalf("spa fallback: %d", spa.Code)
	}
	if body, _ := io.ReadAll(spa.Body); string(body) != "<html>app shell</html>" {
		t.Fatalf("spa fallback must serve the shell: %s", body)
	}
	if spa.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("spa caching: %q", spa.Header().Get("Cache-Control"))
	}

	for _, path := range []string{"/api/unknown", "/internal/unknown", "/v1/unknown"} {
		unknownServerRoute := get(path)
		if unknownServerRoute.Code != 404 {
			t.Fatalf("reserved server route %s: got %d, want 404", path, unknownServerRoute.Code)
		}
		if body, _ := io.ReadAll(unknownServerRoute.Body); string(body) == "<html>app shell</html>" {
			t.Fatalf("reserved server route %s must not serve the SPA shell", path)
		}
	}

	logo := get("/logo.svg")
	if logo.Code != 200 || logo.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("top-level file: %d %q", logo.Code, logo.Header().Get("Cache-Control"))
	}
}

// The committed placeholder keeps the embed honest without generated
// assets in git.
func TestEmbeddedPlaceholder(t *testing.T) {
	handler := Handler()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest("GET", "/", nil))
	if recorder.Code != 200 {
		t.Fatalf("embedded root: %d", recorder.Code)
	}
}

// The font type must not come from the host's MIME files or from sniffing.
func TestWoff2TypeIgnoresHostMimeTable(t *testing.T) {
	if err := mime.AddExtensionType(".woff2", "application/x-host-mapping"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mime.AddExtensionType(".woff2", "font/woff2") })
	handler := HandlerFor(fstest.MapFS{"assets/font-abc123.woff2": {Data: []byte("not sniffable")}})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest("GET", "/assets/font-abc123.woff2", nil))
	if got := recorder.Header().Get("Content-Type"); got != "font/woff2" {
		t.Fatalf("woff2 content type: %q", got)
	}
}
