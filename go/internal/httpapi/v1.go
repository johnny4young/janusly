// The v1 API surface, shaped against captured reference goldens
// (conformance/goldens/node): every response wraps in the
// {apiVersion, requestId, data|error} envelope with an X-Request-Id header;
// unknown and cross-org runs are an indistinguishable 403 runs_forbidden;
// error bodies carry {code, message, params?}. Dev auth mirrors the
// reference's dev-header mode: x-org-id / x-user-id.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/executors"
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/store"
)

// V1Server owns the /v1 route surface over one engine and pool.
type V1Server struct {
	engine *engine.Engine
	pool   *pgxpool.Pool
	newID  func() string
	hub    *streamHub
}

// NewV1Handler mounts the v1 routes plus /healthz.
func NewV1Handler(eng *engine.Engine, pool *pgxpool.Pool) http.Handler {
	server := &V1Server{engine: eng, pool: pool, newID: uuid.NewString, hub: newStreamHub()}
	go server.hub.listen(context.Background(), pool)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	// Legacy public health — the web's OperationsPage polls this every 20s.
	// Public-safe shape from the reference: no raw bucket/error/key detail.
	// rateLimiter reads healthy (the pilot has no limiter yet) and queue
	// reflects a real bounded DB probe.
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		degraded := pool.Ping(ctx) != nil
		w.Header().Set("Content-Type", "application/json")
		payload, _ := json.Marshal(map[string]any{
			"ok":          true,
			"rateLimiter": map[string]any{"healthy": true, "degradedBuckets": []string{}},
			"queue":       map[string]any{"degraded": degraded},
		})
		_, _ = w.Write(payload)
	})
	// Legacy org-config read: the closed catalog with no tenant rows is an
	// honestly EMPTY list — the same answer the reference gives a fresh org.
	mux.HandleFunc("GET /org/config", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"config":[]}`))
	}))
	mux.HandleFunc("POST /v1/workflows/save", server.auth(server.saveWorkflow))
	mux.HandleFunc("POST /v1/workflows/rollback", server.auth(server.rollbackWorkflow))
	mux.HandleFunc("POST /v1/workflows/readiness", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.readinessCore(r, rc))
	}))
	mux.HandleFunc("POST /workflows/readiness", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.readinessCore(r, rc))
	}))
	mux.HandleFunc("GET /v1/workflows", server.auth(server.listWorkflows))
	mux.HandleFunc("GET /v1/workflows/latest", server.auth(server.latestWorkflowVersion))
	mux.HandleFunc("GET /v1/workflows/versions", server.auth(server.listWorkflowVersions))
	mux.HandleFunc("POST /v1/start", server.auth(server.startRun))
	mux.HandleFunc("POST /v1/webhooks/{workflowId}", server.auth(server.ingestWebhook))
	mux.HandleFunc("GET /v1/run", server.auth(server.getRun))
	mux.HandleFunc("GET /v1/status", server.auth(server.getRun))
	mux.HandleFunc("GET /v1/runs", server.auth(server.listRuns))
	mux.HandleFunc("POST /v1/resume", server.auth(server.resumeRun))
	mux.HandleFunc("POST /v1/run/cancel", server.auth(server.cancelRun))
	mux.HandleFunc("GET /v1/dlq", server.auth(server.listDeadLetters))
	mux.HandleFunc("GET /v1/dlq/clusters", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, server.clustersCore(r, rc))
	}))
	mux.HandleFunc("GET /dlq/clusters", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, server.clustersCore(r, rc))
	}))
	mux.HandleFunc("POST /v1/dlq/redrive", server.auth(server.redrive))
	mux.HandleFunc("POST /v1/dlq/replay", server.auth(server.replayAlias))
	mux.HandleFunc("GET /runs/{runId}/stream", server.auth(server.streamRun))
	mux.HandleFunc("GET /auth/context", server.auth(server.authContext))
	// The AI Studio's tool catalog; the web calls it through /v1.
	mux.HandleFunc("GET /v1/tools", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeV1Data(w, rc.id, executors.NewToolRegistry().Catalog())
	}))
	mux.HandleFunc("GET /tools", server.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(executors.NewToolRegistry().Catalog())
	}))
	server.legacyMutations(mux)
	server.mountCampaignRoutes(mux)
	return WithBrowserHeaders(mux)
}

type v1Request struct {
	orgID  string
	userID string
	id     string
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, rc v1Request)

// auth is the pilot's dev-header gate: the org header is the tenancy scope
// every handler filters by.
func (s *V1Server) auth(next handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rc := v1Request{
			orgID:  strings.TrimSpace(r.Header.Get("x-org-id")),
			userID: strings.TrimSpace(r.Header.Get("x-user-id")),
			id:     requestIDFrom(r),
		}
		if rc.orgID == "" {
			writeV1Error(w, rc.id, http.StatusUnauthorized, "unauthorized", "Unauthorized", nil)
			return
		}
		next(w, r, rc)
	}
}

func writeV1(w http.ResponseWriter, requestID string, status int, payload map[string]any) {
	payload["apiVersion"] = "v1"
	payload["requestId"] = requestID
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Request-Id", requestID)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeV1Data(w http.ResponseWriter, requestID string, data any) {
	writeV1(w, requestID, http.StatusOK, map[string]any{"data": data})
}

func writeV1Error(w http.ResponseWriter, requestID string, status int, code, message string, params map[string]any) {
	errBody := map[string]any{"code": code, "message": message}
	if params != nil {
		errBody["params"] = params
	}
	writeV1(w, requestID, status, map[string]any{"error": errBody})
}

func decodeBody(r *http.Request, into any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20)).Decode(into)
}

var unmarshalFieldPattern = regexp.MustCompile(`rawWorkflow\.(\w+)`)

// contractField turns a parse issue ("nodes: Invalid input...") into the
// golden's params.field value; Go's whole-document unmarshal errors name
// the struct field, which maps back to the wire field.
func contractField(issues []domain.Issue) string {
	if len(issues) == 0 {
		return ""
	}
	message := issues[0].Message
	if match := unmarshalFieldPattern.FindStringSubmatch(message); match != nil {
		return strings.ToLower(match[1][:1]) + match[1][1:]
	}
	field, _, _ := strings.Cut(message, ":")
	return field
}

func (s *V1Server) saveWorkflow(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.saveCore(r, rc))
}

func (s *V1Server) saveCore(r *http.Request, rc v1Request) opResult {
	var raw json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	wf, issues := domain.Parse(raw)
	if wf == nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": contractField(issues)})
	}
	// Save accepts the full platform vocabulary — a node type this backend
	// cannot execute yet is a START-time concern, not a save-time one.
	result := domain.Validate(wf, grammar.DomainValidator)
	var blocking []domain.Issue
	for _, issue := range result.Issues {
		if issue.Code != domain.CodeNodeTypeUnsupportedPilot {
			blocking = append(blocking, issue)
		}
	}
	if len(blocking) > 0 {
		return opError(http.StatusBadRequest, "workflows_validation_failed",
			"Workflow validation failed", map[string]any{"issues": blocking})
	}

	ctx := r.Context()
	q := store.New(s.pool)
	workflowID := wf.ID
	if workflowID == "" {
		workflowID = s.newID()
	}
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: rc.orgID}); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
		name := wf.Name
		if name == "" {
			name = workflowID
		}
		if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{
			ID: workflowID, OrgID: rc.orgID, Name: name,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		}); err != nil {
			if strings.Contains(err.Error(), "workflows_pkey") {
				// The id exists but the active-parent read missed it: either a
				// tombstone in THIS org (a save never resurrects one — the
				// operator restores explicitly first) or another tenant's id.
				owner, stateErr := q.GetWorkflowOwnerState(ctx, workflowID)
				if stateErr == nil && owner.OrgID == rc.orgID && owner.DeletedAt != nil {
					return opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
				}
				return opError(http.StatusConflict, "workflows_save_conflict",
					"Workflow id is already taken", nil)
			}
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
	}
	version, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	versionID := s.newID()
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: rc.orgID, WorkflowID: workflowID,
		Version: version + 1, DagJson: raw,
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	return opOK(map[string]any{
		"workflowId": workflowID, "versionId": versionID, "version": version + 1,
	})
}

func (s *V1Server) startRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.startCore(r, rc))
}

func (s *V1Server) startCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Workflow json.RawMessage `json:"workflow"`
		Input    any             `json:"input"`
	}
	if err := decodeBody(r, &body); err != nil || len(body.Workflow) == 0 {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflow"})
	}
	wf, issues := domain.Parse(body.Workflow)
	if wf == nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflow." + contractField(issues)})
	}
	// Execution needs the executable subset — here the pilot-only code IS
	// blocking, unlike save.
	if result := domain.Validate(wf, grammar.DomainValidator); !result.Valid {
		return opError(http.StatusBadRequest, "workflows_validation_failed",
			"Workflow validation failed", map[string]any{"issues": result.Issues})
	}
	if rejection := s.productionGate(r.Context(), rc.orgID, wf); rejection != nil {
		return *rejection
	}
	runID, err := s.engine.StartRun(r.Context(), engine.StartInput{
		OrgID: rc.orgID, Workflow: wf, Input: body.Input, CreatedBy: rc.userID,
	})
	if err != nil {
		var invalid *engine.InputValidationError
		if errors.As(err, &invalid) {
			return opError(http.StatusBadRequest, "runs_input_invalid",
				err.Error(), map[string]any{"errors": invalid.Errors})
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	return opOK(map[string]any{"runId": runID})
}

const eventsPageDefault = 200

// getRun serves both /v1/run and /v1/status: the reference projects the
// same {run, nodes, events, eventsCursor, eventsHasMore} data for both.
func (s *V1Server) getRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	runID := r.URL.Query().Get("runId")
	ctx := r.Context()
	q := store.New(s.pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: rc.orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Unknown and cross-org are indistinguishable, per the golden.
			writeV1Error(w, rc.id, http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
			return
		}
		s.internal(w, rc, err)
		return
	}
	nodes, err := q.ListRunNodesByRun(ctx, runID)
	if err != nil {
		s.internal(w, rc, err)
		return
	}

	beforeCreatedAt := time.Now().Add(time.Hour)
	beforeID := "￿"
	if cursor := r.URL.Query().Get("eventsCursor"); cursor != "" {
		if at, id, ok := parseEventsCursor(cursor); ok {
			beforeCreatedAt, beforeID = at, id
		}
	}
	limit := eventsPageDefault
	if raw := r.URL.Query().Get("eventsLimit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	events, err := q.ListRunEvents(ctx, store.ListRunEventsParams{
		RunID: runID, BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID,
		PageLimit: int32(limit + 1),
	})
	if err != nil {
		s.internal(w, rc, err)
		return
	}
	hasMore := len(events) > limit
	if hasMore {
		events = events[:limit]
	}
	var nextCursor any
	if hasMore && len(events) > 0 {
		last := events[len(events)-1]
		nextCursor = last.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + last.ID
	}

	nodeViews := make([]map[string]any, 0, len(nodes))
	for _, node := range nodes {
		nodeViews = append(nodeViews, map[string]any{
			"id": node.ID, "runId": node.RunID, "nodeId": node.NodeID,
			"status": node.Status, "stateJson": rawOrNull(node.StateJson),
			"attempts": nullableInt(node.Attempts), "startedAt": timeOrNull(node.StartedAt),
			"finishedAt": timeOrNull(node.FinishedAt), "errorJson": rawOrNull(node.ErrorJson),
		})
	}
	eventViews := make([]map[string]any, 0, len(events))
	for _, event := range events {
		eventViews = append(eventViews, map[string]any{
			"id": event.ID, "runId": event.RunID, "nodeId": textOrNull(event.NodeID),
			"type": event.Type, "payload": rawOrNull(event.Payload),
			"createdAt": timeOrNull(event.CreatedAt), "holdUntil": nil,
		})
	}
	writeV1Data(w, rc.id, map[string]any{
		"run":           runView(run),
		"nodes":         nodeViews,
		"events":        eventViews,
		"eventsCursor":  nextCursor,
		"eventsHasMore": hasMore,
	})
}

// runView emits the reference's full run key set; columns this backend does
// not populate yet surface as nulls, never as missing keys.
func runView(run store.GetRunRow) map[string]any {
	return map[string]any{
		"id": run.ID, "orgId": run.OrgID,
		"workflowVersionId": run.WorkflowVersionID,
		"workflowRolloutId": nil, "workflowRolloutVariant": nil,
		"status": run.Status, "outcomeStatus": nil, "semanticViolationCount": 0,
		"inputJson": rawOrNull(run.InputJson), "outputJson": rawOrNull(run.OutputJson),
		"parentRunId": textOrNull(run.ParentRunID), "parentNodeId": textOrNull(run.ParentNodeID),
		"parentLinkKind": nil, "parentNotificationAfter": nil,
		"recoveryPlaybookAppliedRecordedAt": nil, "recoveryPlaybookValidationRecordedAt": nil,
		"replayMode": textOrNull(run.ReplayMode), "traceId": nil,
		"validationEvidenceLevel": nil,
		"createdBy":               textOrNull(run.CreatedBy), "createdAt": timeOrNull(run.CreatedAt),
	}
}

func (s *V1Server) listRuns(w http.ResponseWriter, r *http.Request, rc v1Request) {
	query := r.URL.Query()
	limit := 100
	if raw := query.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	// The `before` cursor is the contract's opaque `<iso>|<id>` keyset — the
	// client builds the next page's cursor from the last row it received.
	beforeCreatedAt := time.Now().Add(time.Hour)
	beforeID := "￿"
	if cursor := query.Get("before"); cursor != "" {
		at, id, ok := parseEventsCursor(cursor)
		if !ok {
			writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
				map[string]any{"field": "before"})
			return
		}
		beforeCreatedAt, beforeID = at, id
	}
	filterWorkflow := pgtype.Text{String: query.Get("workflowId"), Valid: query.Get("workflowId") != ""}
	filterStatus := pgtype.Text{String: query.Get("status"), Valid: query.Get("status") != ""}
	rows, err := store.New(s.pool).ListRunSummaries(r.Context(), store.ListRunSummariesParams{
		OrgID: rc.orgID, PageLimit: int32(limit),
		BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID,
		FilterWorkflowID: filterWorkflow, FilterStatus: filterStatus,
	})
	if err != nil {
		s.internal(w, rc, err)
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{
			"id": row.ID, "orgId": row.OrgID,
			"workflowId": textOrNull(row.WorkflowID), "workflowName": textOrNull(row.WorkflowName),
			"workflowVersionId": row.WorkflowVersionID, "status": row.Status,
			"hasWaitingNodes": row.HasWaitingNodes, "outcomeStatus": nil,
			"semanticViolationCount": 0, "outputJson": rawOrNull(row.OutputJson),
			"parentRunId": textOrNull(row.ParentRunID), "parentNodeId": textOrNull(row.ParentNodeID),
			"replayMode": textOrNull(row.ReplayMode), "traceId": nil,
			"validationEvidenceLevel": nil,
			"createdBy":               textOrNull(row.CreatedBy), "createdAt": timeOrNull(row.CreatedAt),
		})
	}
	writeV1Data(w, rc.id, items)
}

func (s *V1Server) resumeRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.resumeCore(r, rc))
}

func (s *V1Server) resumeCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		RunID  string `json:"runId"`
		NodeID string `json:"nodeId"`
	}
	if err := decodeBody(r, &body); err != nil || body.RunID == "" || body.NodeID == "" {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	// Tenancy first: a run outside this org is the same Forbidden as a run
	// that never existed.
	if _, err := store.New(s.pool).GetRun(r.Context(), store.GetRunParams{
		ID: body.RunID, OrgID: rc.orgID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	if err := s.engine.ResumeRun(r.Context(), body.RunID, body.NodeID); err != nil {
		switch {
		case errors.Is(err, engine.ErrResumeConflict):
			return opError(http.StatusConflict, "runs_resume_conflict", "Node is not waiting", nil)
		case errors.Is(err, engine.ErrResumeNodeNotFound):
			return opError(http.StatusNotFound, "runs_resume_not_found", "Node not found", nil)
		default:
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
	}
	return opOK(map[string]any{"resumed": true})
}

func (s *V1Server) listWorkflows(w http.ResponseWriter, r *http.Request, rc v1Request) {
	query := r.URL.Query()
	limit := 100
	if raw := query.Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	beforeCreatedAt := time.Now().Add(time.Hour)
	beforeID := "￿"
	if cursor := query.Get("before"); cursor != "" {
		at, id, ok := parseEventsCursor(cursor)
		if !ok {
			writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
				map[string]any{"field": "before"})
			return
		}
		beforeCreatedAt, beforeID = at, id
	}
	search := pgtype.Text{String: query.Get("q"), Valid: query.Get("q") != ""}
	rows, err := store.New(s.pool).ListWorkflowRows(r.Context(), store.ListWorkflowRowsParams{
		OrgID: rc.orgID, PageLimit: int32(limit),
		BeforeCreatedAt: beforeCreatedAt, BeforeID: beforeID, Search: search,
	})
	if err != nil {
		s.internal(w, rc, err)
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
	writeV1Data(w, rc.id, items)
}

// versionView emits the contract's WorkflowVersion key set; columns the
// pilot does not populate surface as explicit nulls.
func versionView(id, orgID, workflowID string, version int32, dagJSON json.RawMessage, createdBy pgtype.Text, createdAt *time.Time) map[string]any {
	return map[string]any{
		"id": id, "orgId": orgID, "workflowId": workflowID, "version": version,
		"dagJson": rawOrNull(dagJSON), "sloJson": nil, "upstreamHealthSources": nil,
		"createdBy": textOrNull(createdBy), "createdAt": timeOrNull(createdAt),
	}
}

// requireActiveWorkflow implements the shared parent gate: missing or
// tombstoned parents read as the same workflow_not_found.
func (s *V1Server) requireActiveWorkflow(w http.ResponseWriter, r *http.Request, rc v1Request) (string, bool) {
	workflowID := strings.TrimSpace(r.URL.Query().Get("workflowId"))
	if workflowID == "" {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflowId"})
		return "", false
	}
	if _, err := store.New(s.pool).GetWorkflow(r.Context(), store.GetWorkflowParams{
		ID: workflowID, OrgID: rc.orgID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeV1Error(w, rc.id, http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
			return "", false
		}
		s.internal(w, rc, err)
		return "", false
	}
	return workflowID, true
}

func (s *V1Server) latestWorkflowVersion(w http.ResponseWriter, r *http.Request, rc v1Request) {
	workflowID, ok := s.requireActiveWorkflow(w, r, rc)
	if !ok {
		return
	}
	row, err := store.New(s.pool).GetLatestWorkflowVersion(r.Context(), store.GetLatestWorkflowVersionParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The contract's response is nullable: an active workflow with no
			// versions reads as null, not an error.
			writeV1Data(w, rc.id, nil)
			return
		}
		s.internal(w, rc, err)
		return
	}
	writeV1Data(w, rc.id, versionView(row.ID, row.OrgID, row.WorkflowID, row.Version,
		row.DagJson, row.CreatedBy, row.CreatedAt))
}

func (s *V1Server) listWorkflowVersions(w http.ResponseWriter, r *http.Request, rc v1Request) {
	workflowID, ok := s.requireActiveWorkflow(w, r, rc)
	if !ok {
		return
	}
	rows, err := store.New(s.pool).ListWorkflowVersions(r.Context(), store.ListWorkflowVersionsParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		s.internal(w, rc, err)
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, versionView(row.ID, row.OrgID, row.WorkflowID, row.Version,
			row.DagJson, row.CreatedBy, row.CreatedAt))
	}
	writeV1Data(w, rc.id, items)
}

// cancelRun ports the reference guards exactly — and note the asymmetry
// with run READS: cancel distinguishes a missing run (404) from a cross-org
// one (403), while reads keep both indistinguishable.
func (s *V1Server) cancelRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.cancelCore(r, rc))
}

// cancelCore ports the reference guards exactly — and note the asymmetry
// with run READS: cancel distinguishes a missing run (404) from a cross-org
// one (403), while reads keep both indistinguishable. The v1 contract
// (golden-verified) validates the body shape FIRST: runId is a required
// string, reason an OPTIONAL STRING.
func (s *V1Server) cancelCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		RunID  string `json:"runId"`
		Reason any    `json:"reason"`
	}
	if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.RunID) == "" {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "runId"})
	}
	var reason any
	if body.Reason != nil {
		text, ok := body.Reason.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
				map[string]any{"field": "reason"})
		}
		reason = text
	}
	owner, err := store.New(s.pool).GetRunOwner(r.Context(), body.RunID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "runs_run_not_found", "Run not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	if owner.OrgID != rc.orgID {
		return opError(http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
	}
	switch owner.Status {
	case "succeeded", "failed", "cancelled", "timed_out":
		return opError(http.StatusConflict, "runs_already_terminal",
			"Run is already {{status}}; cannot cancel",
			map[string]any{"status": owner.Status})
	}
	if err := s.engine.CancelRun(r.Context(), body.RunID, reason); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	return opOK(map[string]any{"runId": body.RunID, "status": "cancelled"})
}

func (s *V1Server) listDeadLetters(w http.ResponseWriter, r *http.Request, rc v1Request) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	rows, err := store.New(s.pool).ListDeadLetterSummaries(r.Context(), store.ListDeadLetterSummariesParams{
		OrgID: rc.orgID, PageLimit: int32(limit),
	})
	if err != nil {
		s.internal(w, rc, err)
		return
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{
			"id": row.ID, "orgId": row.OrgID, "runId": row.RunID, "nodeId": row.NodeID,
			"attempt": row.Attempt, "errorJson": rawOrNull(row.ErrorJson), "status": row.Status,
			"replayedAt": timeOrNull(row.ReplayedAt), "createdAt": timeOrNull(row.CreatedAt),
			"nodeType": textOrNullString(row.NodeType), "workflowName": textOrNull(row.WorkflowName),
			"recovery": nil,
		})
	}
	writeV1Data(w, rc.id, items)
}

func (s *V1Server) redrive(w http.ResponseWriter, r *http.Request, rc v1Request) {
	var body struct {
		DeadLetterID string `json:"deadLetterId"`
	}
	if err := decodeBody(r, &body); err != nil || body.DeadLetterID == "" {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
		return
	}
	if err := s.engine.RedriveDeadLetter(r.Context(), rc.orgID, body.DeadLetterID); err != nil {
		switch {
		case errors.Is(err, engine.ErrDeadLetterNotFound):
			writeV1Error(w, rc.id, http.StatusNotFound, "dlq_not_found", "Dead letter not found", nil)
		case errors.Is(err, engine.ErrRedriveConflict):
			writeV1Error(w, rc.id, http.StatusConflict, "dlq_replay_conflict", "Dead letter replay already claimed", nil)
		default:
			s.internal(w, rc, err)
		}
		return
	}
	writeV1Data(w, rc.id, map[string]any{"redriven": true})
}

// rollbackCore appends a prior snapshot as the new latest version with the
// reference's pre-checks: an active parent (a tombstone behaves as
// not-found for writes too), an org-and-workflow-scoped source version, a
// well-formed source DAG, and a version-increment conflict surfaced as a
// retryable 409.
func (s *V1Server) rollbackCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		WorkflowID      string `json:"workflowId"`
		SourceVersionID string `json:"sourceVersionId"`
	}
	if err := decodeBody(r, &body); err != nil || body.WorkflowID == "" || body.SourceVersionID == "" {
		return opError(http.StatusBadRequest, "workflows_rollback_ids_required",
			"workflowId and sourceVersionId are required", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	owner, err := q.GetWorkflowOwnerState(ctx, body.WorkflowID)
	if err != nil || owner.OrgID != rc.orgID || owner.DeletedAt != nil {
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
		return opError(http.StatusNotFound, "workflow_not_found", "Workflow not found", nil)
	}
	source, err := q.GetWorkflowVersionByID(ctx, store.GetWorkflowVersionByIDParams{
		ID: body.SourceVersionID, OrgID: rc.orgID, WorkflowID: body.WorkflowID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "workflows_source_version_not_found", "Source version not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	if wf, _ := domain.Parse(source.DagJson); wf == nil {
		return opError(http.StatusUnprocessableEntity, "workflows_version_malformed",
			"Workflow version is malformed", nil)
	}
	version, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		WorkflowID: body.WorkflowID, OrgID: rc.orgID,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	versionID := s.newID()
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: rc.orgID, WorkflowID: body.WorkflowID,
		Version: version + 1, DagJson: source.DagJson,
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return opError(http.StatusConflict, "workflows_rollback_conflict",
				"Concurrent rollback conflict — please retry", map[string]any{"attempts": 1})
		}
		return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
	}
	return opOK(map[string]any{
		"workflowId": body.WorkflowID, "versionId": versionID,
		"version": version + 1, "sourceVersion": source.Version,
	})
}

func (s *V1Server) rollbackWorkflow(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.rollbackCore(r, rc))
}

// replayCore is the shared engine redrive with the reference's replay wire
// (success {ok:true}); the pilot-own redrive route reuses it with a richer
// body.
func (s *V1Server) replayCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		DeadLetterID string `json:"deadLetterId"`
	}
	if err := decodeBody(r, &body); err != nil || body.DeadLetterID == "" {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "deadLetterId"})
	}
	if err := s.engine.RedriveDeadLetter(r.Context(), rc.orgID, body.DeadLetterID); err != nil {
		switch {
		case errors.Is(err, engine.ErrDeadLetterNotFound):
			return opError(http.StatusNotFound, "dlq_not_found", "Dead letter not found", nil)
		case errors.Is(err, engine.ErrRedriveConflict):
			return opError(http.StatusConflict, "dlq_replay_conflict",
				"This run can no longer be replayed — it was cancelled or already recovered", nil)
		default:
			return opError(http.StatusInternalServerError, "internal_error", fmt.Sprintf("Internal error: %v", err), nil)
		}
	}
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) replayAlias(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.replayCore(r, rc))
}

func (s *V1Server) internal(w http.ResponseWriter, rc v1Request, err error) {
	writeV1Error(w, rc.id, http.StatusInternalServerError, "internal_error",
		fmt.Sprintf("Internal error: %v", err), nil)
}

func parsePositiveInt(raw string, max int) (int, error) {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid")
	}
	if n > max {
		n = max
	}
	return n, nil
}

func timeFarFuture() time.Time { return time.Now().Add(24 * time.Hour) }

func parseEventsCursor(cursor string) (time.Time, string, bool) {
	at, id, found := strings.Cut(cursor, "|")
	if !found {
		return time.Time{}, "", false
	}
	parsed, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return time.Time{}, "", false
	}
	return parsed, id, true
}

func rawOrNull(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

func timeOrNull(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func textOrNull(t pgtype.Text) any {
	if !t.Valid {
		return nil
	}
	return t.String
}

func textOrNullString(t any) any {
	switch v := t.(type) {
	case string:
		// The list queries COALESCE a truly-absent aggregate to "" (sqlc
		// cannot infer lateral nullability); the wire restores the null.
		if v == "" {
			return nil
		}
		return v
	case *string:
		if v == nil {
			return nil
		}
		return *v
	case pgtype.Text:
		return textOrNull(v)
	default:
		return nil
	}
}

func nullableInt(v pgtype.Int4) any {
	if !v.Valid {
		return nil
	}
	return v.Int32
}
