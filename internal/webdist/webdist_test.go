package webdist

import (
	"io"
	"maps"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"strconv"
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

func encodedDist() fstest.MapFS {
	return fstest.MapFS{
		"index.html":                  {Data: []byte("<html>app shell</html>")},
		"index.html.br":               {Data: []byte("br-shell")},
		"index.html.gz":               {Data: []byte("gz-shell")},
		"assets/app-abc123.js":        {Data: []byte("console.log('identity')")},
		"assets/app-abc123.js.br":     {Data: []byte("br-js")},
		"assets/app-abc123.js.gz":     {Data: []byte("gz-js")},
		"assets/app-abc123.css":       {Data: []byte("body{color:red}")},
		"assets/app-abc123.css.gz":    {Data: []byte("gz-css")},
		"assets/font-abc123.woff2":    {Data: []byte("wOF2 font")},
		"assets/font-abc123.woff2.gz": {Data: []byte("stray")},
		"assets/photo-abc123.png":     {Data: []byte("\x89PNG\r\n\x1a\n")},
		"assets/photo-abc123.png.br":  {Data: []byte("stray")},
	}
}

func serveEncoded(handler http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	// The browser-header middleware sets Vary: Origin before this handler runs.
	recorder.Header().Set("Vary", "Origin")
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestPrecompressedNegotiation(t *testing.T) {
	handler := HandlerFor(encodedDist())
	cases := []struct {
		name, path, accept     string
		wantEncoding, wantBody string
		wantType               string
		wantVaryAcceptEncoding bool
	}{
		{"brotli preferred", "/assets/app-abc123.js", "gzip, deflate, br, zstd", "br", "br-js", "text/javascript; charset=utf-8", true},
		{"gzip only", "/assets/app-abc123.js", "gzip", "gzip", "gz-js", "text/javascript; charset=utf-8", true},
		{"refused brotli", "/assets/app-abc123.js", "br;q=0, gzip", "gzip", "gz-js", "text/javascript; charset=utf-8", true},
		{"no header", "/assets/app-abc123.js", "", "", "console.log('identity')", "text/javascript; charset=utf-8", true},
		{"missing variant falls back", "/assets/app-abc123.css", "br", "", "body{color:red}", "text/css; charset=utf-8", true},
		{"shell", "/", "br", "br", "br-shell", "text/html; charset=utf-8", true},
		{"spa fallback", "/flows/wf-1", "gzip", "gzip", "gz-shell", "text/html; charset=utf-8", true},
		{"woff2 untouched", "/assets/font-abc123.woff2", "gzip, br", "", "wOF2 font", "font/woff2", false},
		{"png untouched", "/assets/photo-abc123.png", "gzip, br", "", "\x89PNG\r\n\x1a\n", "image/png", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := serveEncoded(handler, "GET", tc.path, map[string]string{"Accept-Encoding": tc.accept})
			header := response.Header()
			if response.Code != 200 || header.Get("Content-Encoding") != tc.wantEncoding || response.Body.String() != tc.wantBody {
				t.Fatalf("got %d %q %q", response.Code, header.Get("Content-Encoding"), response.Body.String())
			}
			if header.Get("Content-Type") != tc.wantType {
				t.Fatalf("content type %q", header.Get("Content-Type"))
			}
			if header.Get("Content-Length") != strconv.Itoa(len(tc.wantBody)) {
				t.Fatalf("content length %q for %d bytes", header.Get("Content-Length"), len(tc.wantBody))
			}
			vary := header.Values("Vary")
			if !slices.Contains(vary, "Origin") || slices.Contains(vary, "Accept-Encoding") != tc.wantVaryAcceptEncoding {
				t.Fatalf("vary %v", vary)
			}
			if header.Get("ETag") == "" {
				t.Fatal("missing ETag")
			}
		})
	}
}

func TestPrecompressedCachingAndRanges(t *testing.T) {
	handler := HandlerFor(encodedDist())
	asset := "/assets/app-abc123.js"

	brotli := serveEncoded(handler, "GET", asset, map[string]string{"Accept-Encoding": "br"})
	gzip := serveEncoded(handler, "GET", asset, map[string]string{"Accept-Encoding": "gzip"})
	identity := serveEncoded(handler, "GET", asset, nil)
	etags := []string{brotli.Header().Get("ETag"), gzip.Header().Get("ETag"), identity.Header().Get("ETag")}
	if etags[0] == etags[1] || etags[1] == etags[2] || etags[0] == etags[2] {
		t.Fatalf("each representation needs its own ETag: %v", etags)
	}
	if brotli.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("encoded asset caching: %q", brotli.Header().Get("Cache-Control"))
	}

	revalidated := serveEncoded(handler, "GET", asset, map[string]string{"Accept-Encoding": "br", "If-None-Match": etags[0]})
	if revalidated.Code != 304 || revalidated.Body.Len() != 0 {
		t.Fatalf("revalidation: %d", revalidated.Code)
	}
	crossed := serveEncoded(handler, "GET", asset, map[string]string{"Accept-Encoding": "gzip", "If-None-Match": etags[0]})
	if crossed.Code != 200 || crossed.Body.String() != "gz-js" {
		t.Fatalf("a brotli ETag must not validate the gzip body: %d", crossed.Code)
	}
	shell := serveEncoded(handler, "GET", "/runs/1", map[string]string{"Accept-Encoding": "br"})
	if again := serveEncoded(handler, "GET", "/", map[string]string{"Accept-Encoding": "br", "If-None-Match": shell.Header().Get("ETag")}); again.Code != 304 {
		t.Fatalf("shell revalidation: %d", again.Code)
	}

	head := serveEncoded(handler, "HEAD", asset, map[string]string{"Accept-Encoding": "br"})
	if head.Code != 200 || head.Header().Get("Content-Encoding") != "br" || head.Header().Get("Content-Length") != "5" || head.Body.Len() != 0 {
		t.Fatalf("head: %d %v", head.Code, head.Header())
	}

	ranged := serveEncoded(handler, "GET", asset, map[string]string{"Accept-Encoding": "br", "Range": "bytes=0-6"})
	if ranged.Code != 206 || ranged.Header().Get("Content-Encoding") != "" || ranged.Body.String() != "console" {
		t.Fatalf("ranges come from the identity bytes: %d %q %q", ranged.Code, ranged.Header().Get("Content-Encoding"), ranged.Body.String())
	}
	if ranged.Header().Get("Content-Range") != "bytes 0-6/23" || !slices.Contains(ranged.Header().Values("Vary"), "Accept-Encoding") {
		t.Fatalf("range headers: %v", ranged.Header())
	}

	sibling := serveEncoded(handler, "GET", "/assets/app-abc123.js.br", nil)
	if sibling.Body.String() != "<html>app shell</html>" {
		t.Fatalf("an encoded sibling is not a public file: %q", sibling.Body.String())
	}
}

// The web build and the server must agree on which files get siblings.
func TestCompressibleSetMatchesWebBuild(t *testing.T) {
	source, err := os.ReadFile("../../web/scripts/precompress-plugin.mjs")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)COMPRESSIBLE_EXTENSIONS = new Set\(\[(.*?)\]\)`).FindSubmatch(source)
	if block == nil {
		t.Fatal("COMPRESSIBLE_EXTENSIONS not found in the web build plugin")
	}
	var web []string
	for _, match := range regexp.MustCompile(`'(\.[a-z0-9]+)'`).FindAllSubmatch(block[1], -1) {
		web = append(web, string(match[1]))
	}
	server := slices.Sorted(maps.Keys(compressible))
	slices.Sort(web)
	if !slices.Equal(web, server) {
		t.Fatalf("web build %v, server %v", web, server)
	}
}
