// Admin CRUD + force-run for upstream health sources (reference
// the API contract). The poller
// (internal/upstream) owns the derived status; these routes own the
// operator config and the "Check now" immediate poll.
package httpapi

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/upstream"
)

var upstreamSourceNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$`)

type upstreamSourceBody struct {
	Source struct {
		Name                 string   `json:"name"`
		Kind                 string   `json:"kind"`
		URL                  string   `json:"url"`
		ExpectedComponents   []string `json:"expectedComponents"`
		CheckIntervalSeconds *int     `json:"checkIntervalSeconds"`
		Enabled              *bool    `json:"enabled"`
	} `json:"source"`
}

func upstreamSourceView(row store.UpstreamHealthSource) map[string]any {
	return map[string]any{
		"id": row.ID, "name": row.Name, "kind": row.Kind, "url": row.Url,
		"expectedComponents":   upstream.ExpectedComponents(row.ExpectedComponents),
		"checkIntervalSeconds": row.CheckIntervalSeconds, "enabled": row.Enabled,
		"lastStatus": textOrNull(row.LastStatus), "lastDegraded": row.LastDegraded,
		"lastCheckedAt": row.LastCheckedAt, "lastErrorReason": textOrNull(row.LastErrorReason),
	}
}

func (s *V1Server) parseUpstreamSourceBody(r *http.Request) (store.UpdateUpstreamHealthSourceParams, *opResult) {
	fail := func(message string) *opResult {
		res := opError(http.StatusBadRequest, "upstream_invalid_source", message, nil)
		return &res
	}
	var body upstreamSourceBody
	if err := decodeBody(r, &body); err != nil {
		return store.UpdateUpstreamHealthSourceParams{}, fail("invalid body")
	}
	source := body.Source
	name := strings.TrimSpace(source.Name)
	url := strings.TrimSpace(source.URL)
	if name == "" || len(name) > 80 || !upstreamSourceNamePattern.MatchString(name) ||
		!upstream.Kinds[source.Kind] ||
		url == "" || len(url) > 2048 || (!strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://")) ||
		len(source.ExpectedComponents) > upstream.MaxExpectedComponents {
		return store.UpdateUpstreamHealthSourceParams{}, fail("invalid upstream health source")
	}
	for _, component := range source.ExpectedComponents {
		if strings.TrimSpace(component) == "" || len(component) > 120 {
			return store.UpdateUpstreamHealthSourceParams{}, fail("invalid expected component")
		}
	}
	interval := upstream.DefaultCheckIntervalSeconds
	if source.CheckIntervalSeconds != nil {
		interval = *source.CheckIntervalSeconds
		if interval < upstream.MinCheckIntervalSeconds || interval > upstream.MaxCheckIntervalSeconds {
			return store.UpdateUpstreamHealthSourceParams{}, fail("checkIntervalSeconds out of range")
		}
	}
	enabled := true
	if source.Enabled != nil {
		enabled = *source.Enabled
	}
	components := source.ExpectedComponents
	if components == nil {
		components = []string{}
	}
	componentsJSON, _ := json.Marshal(components)
	return store.UpdateUpstreamHealthSourceParams{
		Name: name, Kind: source.Kind, Url: url,
		ExpectedComponents:   componentsJSON,
		CheckIntervalSeconds: int32(interval), Enabled: enabled,
	}, nil
}

func (s *V1Server) mountUpstreamHealthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /upstream/sources", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).ListUpstreamHealthSources(r.Context(), rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, upstreamSourceView(row))
		}
		writeUnversioned(w, opOK(map[string]any{"sources": views}))
	}))

	mux.HandleFunc("POST /upstream/sources", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		params, bad := s.parseUpstreamSourceBody(r)
		if bad != nil {
			writeUnversioned(w, *bad)
			return
		}
		row, err := store.New(s.pool).InsertUpstreamHealthSource(r.Context(), store.InsertUpstreamHealthSourceParams{
			ID: uuid.NewString(), OrgID: rc.orgID,
			Name: params.Name, Kind: params.Kind, Url: params.Url,
			ExpectedComponents:   params.ExpectedComponents,
			CheckIntervalSeconds: params.CheckIntervalSeconds, Enabled: params.Enabled,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			if isUniqueViolation(err) {
				writeUnversioned(w, opError(http.StatusConflict, "upstream_source_conflict", "source name already exists", nil))
				return
			}
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "upstream_health.source.created", audit.Options{
			TargetType: "upstream-health-source", TargetID: row.ID,
			Metadata: map[string]any{"name": row.Name, "kind": row.Kind},
		})
		writeUnversioned(w, opResult{status: http.StatusCreated, data: map[string]any{"source": upstreamSourceView(row)}})
	}))

	mux.HandleFunc("POST /upstream/sources/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		params, bad := s.parseUpstreamSourceBody(r)
		if bad != nil {
			writeUnversioned(w, *bad)
			return
		}
		params.OrgID, params.ID = rc.orgID, r.PathValue("id")
		row, err := store.New(s.pool).UpdateUpstreamHealthSource(r.Context(), params)
		if err != nil {
			if isUniqueViolation(err) {
				writeUnversioned(w, opError(http.StatusConflict, "upstream_source_conflict", "source name already exists", nil))
				return
			}
			writeUnversioned(w, opError(http.StatusNotFound, "upstream_source_not_found", "source not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "upstream_health.source.updated", audit.Options{
			TargetType: "upstream-health-source", TargetID: row.ID,
			Metadata: map[string]any{"name": row.Name, "kind": row.Kind},
		})
		writeUnversioned(w, opOK(map[string]any{"source": upstreamSourceView(row)}))
	}))

	mux.HandleFunc("DELETE /upstream/sources/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		row, err := store.New(s.pool).DeleteUpstreamHealthSource(r.Context(), store.DeleteUpstreamHealthSourceParams{
			OrgID: rc.orgID, ID: r.PathValue("id"),
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "upstream_source_not_found", "source not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "upstream_health.source.deleted", audit.Options{
			TargetType: "upstream-health-source", TargetID: row.ID,
			Metadata: map[string]any{"name": row.Name},
		})
		writeUnversioned(w, opOK(map[string]any{"ok": true}))
	}))

	// "Check now": an immediate one-off poll of a single source.
	mux.HandleFunc("POST /upstream/sources/{id}/check", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		source, err := store.New(s.pool).GetUpstreamHealthSource(r.Context(), store.GetUpstreamHealthSourceParams{
			OrgID: rc.orgID, ID: r.PathValue("id"),
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusNotFound, "upstream_source_not_found", "source not found", nil))
			return
		}
		outcome := upstream.PollOneSource(r.Context(), s.pool, source, upstream.DefaultFetcher)
		paused, resumed := outcome.PausedWorkflowIDs, outcome.ResumedWorkflowIDs
		if paused == nil {
			paused = []string{}
		}
		if resumed == nil {
			resumed = []string{}
		}
		response := map[string]any{
			"failedOpen":         outcome.FailedOpen,
			"pausedWorkflowIds":  paused,
			"resumedWorkflowIds": resumed,
		}
		if outcome.Parse.OK {
			response["status"] = outcome.Parse.Status
			response["degraded"] = outcome.Parse.Degraded
		} else {
			response["reason"] = outcome.Parse.Reason
		}
		writeUnversioned(w, opOK(response))
	}))
}
