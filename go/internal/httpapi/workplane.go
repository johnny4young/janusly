// Work-plane cutover gate. A production shadow can serve reads without
// owning PostgreSQL claims, due clocks, or durable mutations. Activation is
// process-wide because the Go worker and background sweeps are global rather
// than tenant-filtered.
package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
)

const WorkPlaneHeader = "X-Janusly-Work-Plane"

var passiveMutatingReads = map[string]bool{
	"/auth/sso/start":       true,
	"/auth/sso/callback":    true,
	"/billing/usage/export": true,
	"/reports/run-explain":  true,
}

// WithWorkPlaneGate exposes the process ownership mode on every response and
// makes passive mode read-only before authentication or handler side effects.
func WithWorkPlaneGate(next http.Handler, enabled bool) http.Handler {
	mode := "passive"
	if enabled {
		mode = "active"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(WorkPlaneHeader, mode)
		if enabled || passiveRequestAllowed(r) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"code":    "go_work_plane_passive",
			"message": "Go work plane is passive",
		})
	})
}

func passiveRequestAllowed(r *http.Request) bool {
	if passiveMutatingReads[r.URL.Path] ||
		(strings.HasPrefix(r.URL.Path, "/eval/datasets/") && strings.HasSuffix(r.URL.Path, "/export")) {
		return false
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}
