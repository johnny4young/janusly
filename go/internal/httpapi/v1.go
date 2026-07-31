// The v1 API surface, shaped against captured reference goldens
// (conformance/goldens/node): every response wraps in the
// {apiVersion, requestId, data|error} envelope with an X-Request-Id header;
// unknown and cross-org runs are an indistinguishable 403 runs_forbidden;
// error bodies carry {code, message, params?}. Dev auth mirrors the
// reference's dev-header mode: x-org-id / x-user-id.
package httpapi

import (
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
	"github.com/johnny4young/janusly/go/internal/grammar"
	"github.com/johnny4young/janusly/go/internal/store"
)

// V1Server owns the /v1 route surface over one engine and pool.
type V1Server struct {
	engine *engine.Engine
	pool   *pgxpool.Pool
	newID  func() string
}

// NewV1Handler mounts the v1 routes plus /healthz.
func NewV1Handler(eng *engine.Engine, pool *pgxpool.Pool) http.Handler {
	server := &V1Server{engine: eng, pool: pool, newID: uuid.NewString}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("POST /v1/workflows/save", server.auth(server.saveWorkflow))
	mux.HandleFunc("POST /v1/start", server.auth(server.startRun))
	mux.HandleFunc("GET /v1/run", server.auth(server.getRun))
	mux.HandleFunc("GET /v1/status", server.auth(server.getRun))
	mux.HandleFunc("GET /v1/runs", server.auth(server.listRuns))
	mux.HandleFunc("POST /v1/resume", server.auth(server.resumeRun))
	mux.HandleFunc("POST /v1/run/cancel", server.auth(server.cancelRun))
	mux.HandleFunc("GET /v1/dlq", server.auth(server.listDeadLetters))
	mux.HandleFunc("POST /v1/dlq/redrive", server.auth(server.redrive))
	mux.HandleFunc("POST /v1/dlq/replay", server.auth(server.replayAlias))
	return mux
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
			id:     s.newID(),
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
	var raw json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
		return
	}
	wf, issues := domain.Parse(raw)
	if wf == nil {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": contractField(issues)})
		return
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
		writeV1Error(w, rc.id, http.StatusBadRequest, "workflows_validation_failed",
			"Workflow validation failed", map[string]any{"issues": blocking})
		return
	}

	ctx := r.Context()
	q := store.New(s.pool)
	workflowID := wf.ID
	if workflowID == "" {
		workflowID = s.newID()
	}
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: rc.orgID}); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			s.internal(w, rc, err)
			return
		}
		name := wf.Name
		if name == "" {
			name = workflowID
		}
		if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{
			ID: workflowID, OrgID: rc.orgID, Name: name,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		}); err != nil {
			// The id exists under another org: same-name collision across
			// tenants surfaces as the reference's save-conflict code.
			if strings.Contains(err.Error(), "workflows_pkey") {
				writeV1Error(w, rc.id, http.StatusConflict, "workflows_save_conflict",
					"Workflow id is already taken", nil)
				return
			}
			s.internal(w, rc, err)
			return
		}
	}
	version, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		WorkflowID: workflowID, OrgID: rc.orgID,
	})
	if err != nil {
		s.internal(w, rc, err)
		return
	}
	versionID := s.newID()
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: rc.orgID, WorkflowID: workflowID,
		Version: version + 1, DagJson: raw,
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		s.internal(w, rc, err)
		return
	}
	writeV1Data(w, rc.id, map[string]any{
		"workflowId": workflowID, "versionId": versionID, "version": version + 1,
	})
}

func (s *V1Server) startRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	var body struct {
		Workflow json.RawMessage `json:"workflow"`
		Input    any             `json:"input"`
	}
	if err := decodeBody(r, &body); err != nil || len(body.Workflow) == 0 {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflow"})
		return
	}
	wf, issues := domain.Parse(body.Workflow)
	if wf == nil {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflow." + contractField(issues)})
		return
	}
	// Execution needs the executable subset — here the pilot-only code IS
	// blocking, unlike save.
	if result := domain.Validate(wf, grammar.DomainValidator); !result.Valid {
		writeV1Error(w, rc.id, http.StatusBadRequest, "workflows_validation_failed",
			"Workflow validation failed", map[string]any{"issues": result.Issues})
		return
	}
	runID, err := s.engine.StartRun(r.Context(), engine.StartInput{
		OrgID: rc.orgID, Workflow: wf, Input: body.Input, CreatedBy: rc.userID,
	})
	if err != nil {
		var invalid *engine.InputValidationError
		if errors.As(err, &invalid) {
			writeV1Error(w, rc.id, http.StatusBadRequest, "runs_input_invalid",
				err.Error(), map[string]any{"errors": invalid.Errors})
			return
		}
		s.internal(w, rc, err)
		return
	}
	writeV1Data(w, rc.id, map[string]any{"runId": runID})
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
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	rows, err := store.New(s.pool).ListRunSummaries(r.Context(), store.ListRunSummariesParams{
		OrgID: rc.orgID, PageLimit: int32(limit),
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
	var body struct {
		RunID  string `json:"runId"`
		NodeID string `json:"nodeId"`
	}
	if err := decodeBody(r, &body); err != nil || body.RunID == "" || body.NodeID == "" {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
		return
	}
	// Tenancy first: a run outside this org is the same Forbidden as a run
	// that never existed.
	if _, err := store.New(s.pool).GetRun(r.Context(), store.GetRunParams{
		ID: body.RunID, OrgID: rc.orgID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeV1Error(w, rc.id, http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
			return
		}
		s.internal(w, rc, err)
		return
	}
	if err := s.engine.ResumeRun(r.Context(), body.RunID, body.NodeID); err != nil {
		switch {
		case errors.Is(err, engine.ErrResumeConflict):
			writeV1Error(w, rc.id, http.StatusConflict, "runs_resume_conflict", "Node is not waiting", nil)
		case errors.Is(err, engine.ErrResumeNodeNotFound):
			writeV1Error(w, rc.id, http.StatusNotFound, "runs_resume_not_found", "Node not found", nil)
		default:
			s.internal(w, rc, err)
		}
		return
	}
	writeV1Data(w, rc.id, map[string]any{"resumed": true})
}

// cancelRun ports the reference guards exactly — and note the asymmetry
// with run READS: cancel distinguishes a missing run (404) from a cross-org
// one (403), while reads keep both indistinguishable.
func (s *V1Server) cancelRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	// The v1 contract (golden-verified) validates the body shape FIRST:
	// runId is a required string, reason an OPTIONAL STRING — an object
	// reason is a 400 invalid_input naming the field, not an accepted value.
	var body struct {
		RunID  string `json:"runId"`
		Reason any    `json:"reason"`
	}
	if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.RunID) == "" {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "runId"})
		return
	}
	var reason any
	if body.Reason != nil {
		text, ok := body.Reason.(string)
		if !ok || strings.TrimSpace(text) == "" {
			writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
				map[string]any{"field": "reason"})
			return
		}
		reason = text
	}
	owner, err := store.New(s.pool).GetRunOwner(r.Context(), body.RunID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeV1Error(w, rc.id, http.StatusNotFound, "runs_run_not_found", "Run not found", nil)
			return
		}
		s.internal(w, rc, err)
		return
	}
	if owner.OrgID != rc.orgID {
		writeV1Error(w, rc.id, http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
		return
	}
	switch owner.Status {
	case "succeeded", "failed", "cancelled", "timed_out":
		writeV1Error(w, rc.id, http.StatusConflict, "runs_already_terminal",
			"Run is already {{status}}; cannot cancel",
			map[string]any{"status": owner.Status})
		return
	}
	if err := s.engine.CancelRun(r.Context(), body.RunID, reason); err != nil {
		s.internal(w, rc, err)
		return
	}
	writeV1Data(w, rc.id, map[string]any{"runId": body.RunID, "status": "cancelled"})
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

// replayAlias exposes the reference's /v1/dlq/replay wire shape over the
// same engine redrive: success {ok:true}, conflict with the reference's
// message. The pilot-own /v1/dlq/redrive stays for its richer body.
func (s *V1Server) replayAlias(w http.ResponseWriter, r *http.Request, rc v1Request) {
	var body struct {
		DeadLetterID string `json:"deadLetterId"`
	}
	if err := decodeBody(r, &body); err != nil || body.DeadLetterID == "" {
		writeV1Error(w, rc.id, http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "deadLetterId"})
		return
	}
	if err := s.engine.RedriveDeadLetter(r.Context(), rc.orgID, body.DeadLetterID); err != nil {
		switch {
		case errors.Is(err, engine.ErrDeadLetterNotFound):
			writeV1Error(w, rc.id, http.StatusNotFound, "dlq_not_found", "Dead letter not found", nil)
		case errors.Is(err, engine.ErrRedriveConflict):
			writeV1Error(w, rc.id, http.StatusConflict, "dlq_replay_conflict",
				"This run can no longer be replayed — it was cancelled or already recovered", nil)
		default:
			s.internal(w, rc, err)
		}
		return
	}
	writeV1Data(w, rc.id, map[string]any{"ok": true})
}

func (s *V1Server) internal(w http.ResponseWriter, rc v1Request, err error) {
	writeV1Error(w, rc.id, http.StatusInternalServerError, "internal_error",
		fmt.Sprintf("Internal error: %v", err), nil)
}

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
		return v
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
