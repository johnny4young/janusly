// Single-binary web serving: the Vite dist is embedded via go:embed and
// served with SPA fallback plus cache headers. Release builds stage the
// generated web/dist tree over the committed placeholder before compiling;
// no generated frontend asset is written back into the Git worktree.
//
// Cache contract: hashed assets under /assets/ are immutable (1 year);
// index.html and other top-level files are no-cache so a redeploy is
// picked up on the next load.
package webdist

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

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
