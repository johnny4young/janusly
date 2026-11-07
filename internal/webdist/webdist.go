// Single-binary web serving: the Vite dist is embedded via go:embed and
// served with SPA fallback plus cache headers. Release builds stage the
// generated web/dist tree over the committed placeholder before compiling;
// no generated frontend asset is written back into the Git worktree.
//
// Cache contract: hashed assets under /assets/ are immutable (1 year);
// index.html and other top-level files are no-cache so a redeploy is
// picked up on the next load. Text files are served from the .br/.gz
// siblings the web build writes; nothing is compressed per request.
package webdist

import (
	"bytes"
	"embed"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/httpkit"
)

//go:embed all:dist
var embedded embed.FS

// Types pinned here never depend on the host's MIME table or on sniffing.
var contentTypes = map[string]string{
	".css":         "text/css; charset=utf-8",
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".mjs":         "text/javascript; charset=utf-8",
	".svg":         "image/svg+xml",
	".txt":         "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".woff2":       "font/woff2",
	".xml":         "text/xml; charset=utf-8",
}

// Already-compressed formats such as woff2 and png are absent, so a stray
// sibling for them is never served.
var compressible = map[string]bool{
	".css": true, ".html": true, ".js": true, ".json": true, ".map": true, ".mjs": true,
	".svg": true, ".txt": true, ".webmanifest": true, ".xml": true,
}

// Server preference order: brotli is smaller when both are accepted.
var encodings = []struct{ coding, suffix string }{{"br", ".br"}, {"gzip", ".gz"}}

type representation struct {
	path string
	etag string
}

type asset struct {
	identity    representation
	contentType string
	encoded     map[string]representation
	codings     []string
}

// Handler serves the embedded production bundle.
func Handler() http.Handler {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		return http.NotFoundHandler()
	}
	return HandlerFor(sub)
}

// HandlerFor serves any dist-shaped fs.FS: exact files first, immutable
// caching for hashed /assets/, and the SPA fallback to index.html for
// every path that is not a file (client-side routes).
func HandlerFor(dist fs.FS) http.Handler {
	assets := indexAssets(dist)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		if file, ok := assets[name]; ok {
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				// Vite content-hashes every asset filename: safe forever.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			serveAsset(w, r, dist, file)
			return
		}
		// Versioned and internal server namespaces are never client routes.
		// Without this boundary, an undeclared API probe would receive the
		// HTML shell with HTTP 200, hiding route/configuration mistakes behind
		// an apparently successful response.
		firstSegment := strings.SplitN(name, "/", 2)[0]
		switch firstSegment {
		case "api", "internal", "v1":
			http.NotFound(w, r)
			return
		}
		// SPA fallback: client-side routes render index.html.
		shell, ok := assets["index.html"]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		serveAsset(w, r, dist, shell)
	})
}

func indexAssets(dist fs.FS) map[string]asset {
	files := map[string][]byte{}
	_ = fs.WalkDir(dist, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if body, readErr := fs.ReadFile(dist, name); readErr == nil {
			files[name] = body
		}
		return nil
	})
	assets := map[string]asset{}
	for name, body := range files {
		if isEncodedSibling(name, files) {
			continue
		}
		ext := path.Ext(name)
		file := asset{identity: representation{path: name, etag: httpkit.StrongETag(body)}, contentType: contentTypes[ext]}
		if compressible[ext] {
			for _, encoding := range encodings {
				if sibling, ok := files[name+encoding.suffix]; ok {
					if file.encoded == nil {
						file.encoded = map[string]representation{}
					}
					file.encoded[encoding.coding] = representation{path: name + encoding.suffix, etag: httpkit.StrongETag(sibling)}
					file.codings = append(file.codings, encoding.coding)
				}
			}
		}
		assets[name] = file
	}
	return assets
}

func isEncodedSibling(name string, files map[string][]byte) bool {
	for _, encoding := range encodings {
		base, ok := strings.CutSuffix(name, encoding.suffix)
		if _, exists := files[base]; ok && exists && compressible[path.Ext(base)] {
			return true
		}
	}
	return false
}

func serveAsset(w http.ResponseWriter, r *http.Request, dist fs.FS, file asset) {
	if file.contentType != "" {
		w.Header().Set("Content-Type", file.contentType)
	}
	selected, coding := file.identity, ""
	if len(file.codings) > 0 {
		w.Header().Add("Vary", "Accept-Encoding")
		if r.Header.Get("Range") == "" {
			coding = httpkit.NegotiateEncoding(r.Header.Get("Accept-Encoding"), file.codings...)
			if coding != "" {
				selected = file.encoded[coding]
			}
		}
	}
	content, closeContent, err := openSeeker(dist, selected.path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer closeContent()
	w.Header().Set("ETag", selected.etag)
	if coding == "" {
		http.ServeContent(w, r, file.identity.path, time.Time{}, content)
		return
	}
	httpkit.ServeEncoded(w, r, coding, content)
}

func openSeeker(dist fs.FS, name string) (io.ReadSeeker, func(), error) {
	file, err := dist.Open(name)
	if err != nil {
		return nil, nil, err
	}
	closeFile := func() { _ = file.Close() }
	if seeker, ok := file.(io.ReadSeeker); ok {
		return seeker, closeFile, nil
	}
	defer closeFile()
	body, err := io.ReadAll(file)
	if err != nil {
		return nil, nil, err
	}
	return bytes.NewReader(body), func() {}, nil
}
