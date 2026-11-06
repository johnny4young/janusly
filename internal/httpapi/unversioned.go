// Unversioned routes are the paths the web uses directly. Versioned /v1
// routes wrap the same operations in an envelope. Both forms share one
// operation core per mutation and use dedicated encoders, preventing handler
// drift between the two current HTTP contracts.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/store"
)

// opResult is one mutation outcome, wire-agnostic.
type opResult struct {
	status  int
	code    string
	message string
	params  map[string]any
	data    any
	// unversionedExtras merge top-level fields into the unversioned error body
	// while /v1 keeps the same values inside params.
	unversionedExtras map[string]any
	// retryAfterSec, when set, is emitted as the Retry-After header so a
	// rate-limited client can back off without parsing the body.
	retryAfterSec int
}

func opOK(data any) opResult { return fromKit(httpkit.OK(data)) }

func opError(status int, code, message string, params map[string]any) opResult {
	return fromKit(httpkit.Error(status, code, message, params))
}

func writeUnversioned(w http.ResponseWriter, result opResult) {
	httpkit.WriteUnversioned(w, toKit(result))
}

func writeVersioned(w http.ResponseWriter, requestID string, result opResult) {
	httpkit.WriteVersioned(w, requestID, toKit(result))
}

// unversionedRoutes mounts the raw-wire aliases over the shared cores.
func (s *V1Server) unversionedRoutes(mux *http.ServeMux) {
	// Workflow lifecycle: soft delete, trash, restore on the unversioned routes.
	s.route(mux, "DELETE /workflows/{workflowId}", routeGate{auth.RoleEditor, "workflows.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if err := s.engine.DeactivateWorkflow(r.Context(), rc.orgID, workflowID); err != nil {
			if errors.Is(err, engine.ErrWorkflowLifecycleNotFound) {
				writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
				return
			}
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		s.audit.Write(r.Context(), s.pool, rc.authContext, "workflow.deleted", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"soft": true},
		})
		writeUnversioned(w, opOK(map[string]any{"workflowId": workflowID, "ok": true}))
	})
	s.route(mux, "POST /workflows/{workflowId}/restore", routeGate{auth.RoleEditor, "workflows.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		if err := s.engine.ReactivateWorkflow(r.Context(), rc.orgID, workflowID, rc.userID); err != nil {
			switch {
			case errors.Is(err, engine.ErrWorkflowLifecycleNotFound):
				writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			case errors.Is(err, engine.ErrWorkflowVersionMalformed):
				writeUnversioned(w, opError(http.StatusUnprocessableEntity, "workflows_version_malformed",
					"Workflow version is malformed", nil))
			default:
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			}
			return
		}
		s.audit.Write(r.Context(), s.pool, rc.authContext, "workflow.restored", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
		})
		writeUnversioned(w, opOK(map[string]any{"workflowId": workflowID, "ok": true}))
	})
	s.route(mux, "GET /workflows/trash", routeGate{auth.RoleViewer, "workflows.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		query := r.URL.Query()
		limit := 100
		if raw := query.Get("limit"); raw != "" {
			if n, err := parsePositiveInt(raw, 200); err == nil {
				limit = n
			}
		}
		// The trash cursor's instant is the row's deletedAt, not createdAt.
		beforeDeletedAt := timeFarFuture()
		beforeID := "￿"
		if cursor := query.Get("before"); cursor != "" {
			if at, id, ok := parseEventsCursor(cursor); ok {
				beforeDeletedAt, beforeID = at, id
			}
		}
		rows, err := store.New(s.pool).ListDeletedWorkflowRows(r.Context(), store.ListDeletedWorkflowRowsParams{
			OrgID: rc.orgID, PageLimit: int32(limit),
			BeforeDeletedAt: beforeDeletedAt, BeforeID: beforeID,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			items = append(items, map[string]any{
				"id": row.ID, "orgId": row.OrgID, "name": row.Name,
				"createdBy": textOrNull(row.CreatedBy), "createdAt": timeOrNull(row.CreatedAt),
				"lastRunStatus": textOrNullString(row.LastRunStatus), "runCount": row.RunCount,
				"bufferedTriggerCount": row.BufferedTriggerCount,
				"status":               row.Status, "pausedReason": textOrNull(row.PausedReason),
				"tags": decodeStringArray(row.Tags), "folder": textOrNull(row.Folder),
				"deletedAt": timeOrNull(row.DeletedAt),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(items)
	})
	alias := func(pattern string, core func(*http.Request, v1Request) opResult) {
		mux.HandleFunc(pattern, s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			writeUnversioned(w, core(r, rc))
		}))
	}
	alias("POST /start", s.startCore)
	alias("POST /resume", s.resumeCore)
	alias("POST /run/cancel", s.cancelCore)
	alias("POST /workflows/save", s.saveCore)
	alias("POST /workflows/rollback", s.rollbackCore)
	alias("POST /dlq/replay", s.replayCore)
	alias("GET /run", s.getRunCore)
	alias("GET /status", s.getRunCore)
	alias("GET /runs", s.listRunsCore)
	alias("GET /workflows", s.listWorkflowsCore)
	alias("GET /workflows/latest", s.latestWorkflowVersionCore)
	alias("GET /workflows/versions", s.listWorkflowVersionsCore)

	// Unversioned DLQ reads keep the raw response shape used by the web.
	s.route(mux, "GET /dlq/counts", routeGate{auth.RoleViewer, "dlq.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		counts, err := store.New(s.pool).CountDeadLettersByStatus(r.Context(), rc.orgID)
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		totals := map[string]any{"total": 0, "open": 0, "replayed": 0, "resolved": 0}
		total := int64(0)
		for _, row := range counts {
			total += row.Count
			if _, known := totals[row.Status]; known {
				totals[row.Status] = row.Count
			}
		}
		totals["total"] = total
		writeUnversioned(w, opOK(totals))
	})
	s.route(mux, "GET /dlq", routeGate{auth.RoleViewer, "dlq.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		id := r.URL.Query().Get("id")
		if id == "" {
			// Bare /dlq stays an ARRAY (home preview) — the queue page with
			// its envelope lives at /dlq/queue.
			items, bad := s.dlqListItems(r, rc)
			if bad != nil {
				writeUnversioned(w, *bad)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(items)
			return
		}
		writeUnversioned(w, s.deadLetterDetailCore(r, rc, id))
	})
}
