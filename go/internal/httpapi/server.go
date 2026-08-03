// Package httpapi assembles the HTTP surfaces. The public API and the
// internal observability endpoints (Prometheus metrics + pprof) live on
// separate ports so profiling data is never one misconfigured proxy away
// from the public surface.
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/pprof"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/johnny4young/janusly/go/internal/buildinfo"
)

// NewAPIHandler builds the public mux. Routes arrive as the engine grows;
// the health endpoint exists from day one so process supervisors and the
// compose healthcheck have something truthful to ask.
func NewAPIHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return mux
}

// NewInternalHandler builds the observability mux: Prometheus metrics (the
// default registry already carries the Go runtime collectors) and the pprof
// family for profiles.
func NewInternalHandler(identity buildinfo.Identity) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /build", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(identity)
	})
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return mux
}
