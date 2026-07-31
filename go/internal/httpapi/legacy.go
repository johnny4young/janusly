// Legacy wire aliases — the paths the web actually POSTs to. The reference
// keeps legacy routes byte-compatible while /v1 wraps the same operations in
// the envelope; the pilot mirrors that with ONE operation core per mutation
// and two encoders: raw legacy bodies ({...} / {error, code, params?}) and
// the v1 envelope. Handler drift between the two wires is structurally
// impossible — they share the core.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/go/internal/store"
)

// opResult is one mutation outcome, wire-agnostic.
type opResult struct {
	status  int
	code    string
	message string
	params  map[string]any
	data    map[string]any
}

func opOK(data map[string]any) opResult { return opResult{status: http.StatusOK, data: data} }

func opError(status int, code, message string, params map[string]any) opResult {
	return opResult{status: status, code: code, message: message, params: params}
}

func writeLegacy(w http.ResponseWriter, result opResult) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(result.status)
	if result.data != nil {
		_ = json.NewEncoder(w).Encode(result.data)
		return
	}
	body := map[string]any{"error": result.message, "code": result.code}
	if result.params != nil {
		body["params"] = result.params
	}
	_ = json.NewEncoder(w).Encode(body)
}

func writeVersioned(w http.ResponseWriter, requestID string, result opResult) {
	if result.data != nil {
		// Non-200 successes keep their status (202 = accepted, run deferred).
		writeV1(w, requestID, result.status, map[string]any{"data": result.data})
		return
	}
	writeV1Error(w, requestID, result.status, result.code, result.message, result.params)
}

// legacyMutations mounts the raw-wire aliases over the shared cores.
func (s *V1Server) legacyMutations(mux *http.ServeMux) {
	// Workflow lifecycle: soft delete, trash, restore — all legacy wire.
	mux.HandleFunc("DELETE /workflows/{workflowId}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		rows, err := store.New(s.pool).SoftDeleteWorkflow(r.Context(), store.SoftDeleteWorkflowParams{
			ID: workflowID, OrgID: rc.orgID,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if rows == 0 {
			writeLegacy(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		writeLegacy(w, opOK(map[string]any{"workflowId": workflowID, "ok": true}))
	}))
	mux.HandleFunc("POST /workflows/{workflowId}/restore", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		workflowID := r.PathValue("workflowId")
		rows, err := store.New(s.pool).RestoreWorkflow(r.Context(), store.RestoreWorkflowParams{
			ID: workflowID, OrgID: rc.orgID,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if rows == 0 {
			writeLegacy(w, opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil))
			return
		}
		writeLegacy(w, opOK(map[string]any{"workflowId": workflowID, "ok": true}))
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
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			items = append(items, map[string]any{
				"id": row.ID, "orgId": row.OrgID, "name": row.Name,
				"createdBy": textOrNull(row.CreatedBy), "createdAt": timeOrNull(row.CreatedAt),
				"lastRunStatus": textOrNullString(row.LastRunStatus), "runCount": row.RunCount,
				"bufferedTriggerCount": 0,
				"status":               row.Status, "pausedReason": textOrNull(row.PausedReason),
				"tags": []string{}, "folder": nil, "deletedAt": timeOrNull(row.DeletedAt),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(items)
	}))
	alias := func(pattern string, core func(*http.Request, v1Request) opResult) {
		mux.HandleFunc(pattern, s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
			writeLegacy(w, core(r, rc))
		}))
	}
	alias("POST /start", s.startCore)
	alias("POST /resume", s.resumeCore)
	alias("POST /run/cancel", s.cancelCore)
	alias("POST /workflows/save", s.saveCore)
	alias("POST /workflows/rollback", s.rollbackCore)
	alias("POST /dlq/replay", s.replayCore)

	// Legacy DLQ reads the web keeps on the raw wire by design.
	mux.HandleFunc("GET /dlq/counts", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		counts, err := store.New(s.pool).CountDeadLettersByStatus(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
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
		writeLegacy(w, opOK(totals))
	}))
	mux.HandleFunc("GET /dlq", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		id := r.URL.Query().Get("id")
		if id == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "dlq_id_required", "id is required", nil))
			return
		}
		row, err := store.New(s.pool).GetDeadLetter(r.Context(), store.GetDeadLetterParams{ID: id, OrgID: rc.orgID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeLegacy(w, opError(http.StatusNotFound, "dlq_not_found", "Dead letter not found", nil))
				return
			}
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		writeLegacy(w, opOK(map[string]any{
			"id": row.ID, "orgId": row.OrgID, "runId": row.RunID, "nodeId": row.NodeID,
			"attempt": row.Attempt, "workflowJson": rawOrNull(row.WorkflowJson),
			"nodeJson": rawOrNull(row.NodeJson), "errorJson": rawOrNull(row.ErrorJson),
			"status": row.Status, "replayedAt": timeOrNull(row.ReplayedAt),
			"createdAt":       timeOrNull(row.CreatedAt),
			"replayClaimedAt": timeOrNull(row.ReplayClaimedAt),
			"suspectVersion":  nil, "drill": nil, "drillOutcome": nil,
		}))
	}))
}
