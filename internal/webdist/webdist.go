// Single-binary web serving: the Vite dist embedded via go:embed
// and served with SPA fallback + cache headers, behind an explicit env
// flag so the API's default posture (headless) is unchanged.
//
// The committed dist/ holds only an honest placeholder page; `make
// web-embed` copies the real `apps/web/dist` build in before `go build`
// (generated assets stay out of git). The handler takes an fs.FS seam so
// tests can pin the serving contract without a real Vite build.
//
// Cache contract: hashed assets under /assets/ are immutable (1 year);
// index.html and other top-level files are no-cache so a redeploy is
// picked up on the next load.
package webdist

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

// Enabled reports whether the single-binary web flag is on.
func Enabled() bool {
	return os.Getenv("JANUSLY_SERVE_WEB") == "true"
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
	fileServer := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if file, err := dist.Open(path); err == nil {
			info, statErr := file.Stat()
			_ = file.Close()
			if statErr == nil && !info.IsDir() {
				if strings.HasPrefix(r.URL.Path, "/assets/") {
					// Vite content-hashes every asset filename: safe forever.
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		// SPA fallback: client-side routes render index.html.
		index, err := dist.Open("index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer func() { _ = index.Close() }()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		raw, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(raw)
	})
}
