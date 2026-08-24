package webdist

import (
	"io"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// Exact files serve with the right cache posture; everything else
// falls back to index.html (SPA client routes).
func TestHandlerServingContract(t *testing.T) {
	dist := fstest.MapFS{
		"index.html":            {Data: []byte("<html>app shell</html>")},
		"logo.svg":              {Data: []byte("<svg/>")},
		"assets/app-abc123.js":  {Data: []byte("console.log(1)")},
		"assets/app-abc123.css": {Data: []byte("body{}")},
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
