// Semantic run search: recall over run_summary memories ("find runs like
// this failure"). Dormant by default — the engine only writes summaries
// under the memory consent chain, and Recall re-checks the same chain —
// so a memory-disabled organization gets an honest {enabled:false} and
// an empty list, never an error.
package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/memory"
	"github.com/johnny4young/janusly/internal/ratelimit"
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
	queryRunes := []rune(query)
	if len(queryRunes) > runSearchMaxQueryChars {
		query = string(queryRunes[:runSearchMaxQueryChars])
	}
	if !memory.Enabled(r.Context(), s.pool, rc.orgID) {
		return opOK(map[string]any{"enabled": false, "entries": []memory.RecallEntry{}})
	}
	if limitErr := s.limiter.Enforce(r.Context(), rc.orgID, ratelimit.Options{
		Name: "memory.run_semantic_search", Max: 30, Window: time.Minute,
	}); limitErr != nil {
		return opError(http.StatusTooManyRequests, "rate_limited", limitErr.Error(), nil)
	}
	entries := memory.Recall(r.Context(), s.pool, memory.RecallInput{
		OrgID: rc.orgID, Kind: "run_summary", Query: query,
	})
	return opOK(map[string]any{"enabled": true, "entries": entries})
}
