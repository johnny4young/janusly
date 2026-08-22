// Semantic run search: recall over run_summary memories ("find runs like
// this failure"). Dormant by default — the engine only writes summaries
// under the memory consent chain, and Recall re-checks the same chain —
// so a memory-disabled organization gets an honest {enabled:false} and
// an empty list, never an error.
package httpapi

import (
	"net/http"
	"strings"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/memory"
)

const runSearchMaxQueryChars = 500

func (s *V1Server) mountRunSearchRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /runs/semantic-search", routeGate{auth.RoleViewer, "runs.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.runSemanticSearchCore(r, rc))
	})
	s.route(mux, "GET /v1/runs/semantic-search", routeGate{auth.RoleViewer, "runs.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.runSemanticSearchCore(r, rc))
	})
}

func (s *V1Server) runSemanticSearchCore(r *http.Request, rc v1Request) opResult {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		return opError(http.StatusBadRequest, "invalid_request", "q is required", nil)
	}
	if len(query) > runSearchMaxQueryChars {
		query = query[:runSearchMaxQueryChars]
	}
	if !memory.Enabled(r.Context(), s.pool, rc.orgID) {
		return opOK(map[string]any{"enabled": false, "entries": []memory.RecallEntry{}})
	}
	entries := memory.Recall(r.Context(), s.pool, memory.RecallInput{
		OrgID: rc.orgID, Kind: "run_summary", Query: query,
	})
	return opOK(map[string]any{"enabled": true, "entries": entries})
}
