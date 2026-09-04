// Unversioned routes are the paths the web uses directly. Versioned /v1
// routes wrap the same operations in an envelope. Both forms share one
// operation core per mutation and use dedicated encoders, preventing handler
// drift between the two current HTTP contracts.
package httpapi

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
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

func opOK(data any) opResult { return opResult{status: http.StatusOK, data: data} }

func opError(status int, code, message string, params map[string]any) opResult {
	status = publicErrorStatus(code, status)
	message, params = publicErrorFields(code, message, params)
	return opResult{status: status, code: code, message: message, params: params}
}

// publicErrorFields is the final defense against reflecting database,
// provider, or evidence details through a generic 500. Callers should still
// pass the stable literal, but both encoders normalize it so a future direct
// opResult or writeV1Error cannot bypass the invariant.
func publicErrorFields(code, message string, params map[string]any) (string, map[string]any) {
	if code == "internal_error" {
		return "Internal error", nil
	}
	return message, params
}

func publicErrorStatus(code string, status int) int {
	if code == "internal_error" {
		return http.StatusInternalServerError
	}
	return status
}

func writeUnversioned(w http.ResponseWriter, result opResult) {
	result.status = publicErrorStatus(result.code, result.status)
	if result.retryAfterSec > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(result.retryAfterSec))
	}
	result.message, result.params = publicErrorFields(result.code, result.message, result.params)
	if result.code == "internal_error" {
		result.data = nil
		result.unversionedExtras = nil
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(result.status)
	if result.data != nil || (result.status >= 200 && result.status < 300 && result.code == "") {
		_ = json.NewEncoder(w).Encode(result.data)
		return
	}
	body := map[string]any{"error": result.message, "code": result.code}
	if result.unversionedExtras != nil {
		maps.Copy(body, result.unversionedExtras)
	} else if result.params != nil {
		body["params"] = result.params
	}
	_ = json.NewEncoder(w).Encode(body)
}

func writeVersioned(w http.ResponseWriter, requestID string, result opResult) {
	result.status = publicErrorStatus(result.code, result.status)
	if result.retryAfterSec > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(result.retryAfterSec))
	}
	result.message, result.params = publicErrorFields(result.code, result.message, result.params)
	if result.code == "internal_error" {
		result.data = nil
		result.unversionedExtras = nil
	}
	if result.data != nil || (result.status >= 200 && result.status < 300 && result.code == "") {
		// Non-200 successes keep their status (202 = accepted, run deferred).
		writeV1(w, requestID, result.status, map[string]any{"data": result.data})
		return
	}
	writeV1Error(w, requestID, result.status, result.code, result.message, result.params)
}

// unversionedRoutes mounts the raw-wire aliases over the shared cores.
func (s *V1Server) unversionedRoutes(mux *http.ServeMux) {
	// Workflow lifecycle: soft delete, trash, restore on the unversioned routes.
	mux.HandleFunc("DELETE /workflows/{workflowId}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		// Tombstone + rollout cancellation commit TOGETHER: no active
		// deployment may outlive its deleted workflow (the create path takes
		// the same parent lock, so none can appear in between either).
		tx, err := s.pool.Begin(r.Context())
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		txq := store.New(tx)
		rows, err := txq.SoftDeleteWorkflow(r.Context(), store.SoftDeleteWorkflowParams{
			ID: workflowID, OrgID: rc.orgID,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if rows == 0 {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		if _, err := txq.CancelActiveWorkflowRollout(r.Context(), store.CancelActiveWorkflowRolloutParams{
			OrgID: rc.orgID, WorkflowID: workflowID, Reason: pgtype.Text{String: "workflow_deleted", Valid: true},
		}); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		// A tombstoned workflow must never fire: its schedule entries go
		// with it in the SAME transaction.
		if err := txq.DeleteScheduleEntriesForWorkflow(r.Context(), store.DeleteScheduleEntriesForWorkflowParams{
			OrgID: rc.orgID, WorkflowID: workflowID,
		}); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.deleted", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"soft": true},
		})
		writeUnversioned(w, opOK(map[string]any{"workflowId": workflowID, "ok": true}))
	}))
	mux.HandleFunc("POST /workflows/{workflowId}/restore", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		tx, err := s.pool.Begin(r.Context())
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		txq := store.New(tx)
		rows, err := txq.RestoreWorkflow(r.Context(), store.RestoreWorkflowParams{
			ID: workflowID, OrgID: rc.orgID,
		})
		if err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if rows == 0 {
			writeUnversioned(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		// Restoring the parent and reconstructing its schedules are one state
		// transition. Never report success for an active workflow whose latest
		// snapshot could not be loaded, parsed, or registered.
		version, err := txq.GetLatestWorkflowVersion(r.Context(), store.GetLatestWorkflowVersionParams{
			WorkflowID: workflowID, OrgID: rc.orgID,
		})
		switch {
		case err == nil:
			wf, _ := domain.Parse(version.DagJson)
			if wf == nil {
				writeUnversioned(w, opError(http.StatusUnprocessableEntity, "workflows_version_malformed",
					"Workflow version is malformed", nil))
				return
			}
			if err := s.engine.SyncWorkflowSchedules(r.Context(), txq,
				rc.orgID, workflowID, version.ID, rc.userID, wf); err != nil {
				writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
		case errors.Is(err, pgx.ErrNoRows):
			// A workflow created before its first save has no schedules to restore.
		default:
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "workflow.restored", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
		})
		writeUnversioned(w, opOK(map[string]any{"workflowId": workflowID, "ok": true}))
	}))
	mux.HandleFunc("GET /workflows/trash", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
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
	}))
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
	mux.HandleFunc("GET /dlq/counts", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
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
	}))
	mux.HandleFunc("GET /dlq", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
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
		q := store.New(s.pool)
		row, err := q.GetDeadLetter(r.Context(), store.GetDeadLetterParams{ID: id, OrgID: rc.orgID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeUnversioned(w, opError(http.StatusNotFound, "dlq_not_found", "Dead letter not found", nil))
				return
			}
			writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		view := newDeadLetterDetailView(row)
		if run, runErr := q.GetRun(r.Context(), store.GetRunParams{ID: row.RunID, OrgID: rc.orgID}); runErr == nil {
			view.Drill = parseRecoveryDrillProvenance(run.InputJson)
			if view.Drill != nil {
				if outcome, outcomeErr := s.queryDrillOutcome(r.Context(), rc.orgID, row.ID); outcomeErr == nil {
					view.DrillOutcome = outcome
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(view)
	}))
}
