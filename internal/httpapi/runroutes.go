// Run lifecycle handlers: start (rollout assignment + production gate),
// run/status/list reads with the events keyset, resume, cancel, DLQ list,
// redrive, and replay. The split preserves the existing wire contract.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/runstart"
	"github.com/johnny4young/janusly/internal/store"
)

func (s *V1Server) startRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.startCore(r, rc))
}

func (s *V1Server) startCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Workflow          json.RawMessage `json:"workflow"`
		WorkflowVersionID string          `json:"workflowVersionId"`
		Input             any             `json:"input"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 2<<20))
	if err != nil || json.Unmarshal(raw, &body) != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflow"})
	}
	// The web sends the FLAT workflow JSON when starting without input
	// (Node accepts both shapes) — an absent "workflow" key means the
	// whole body IS the workflow.
	if len(body.Workflow) == 0 {
		body.Workflow = raw
	}
	if len(body.Workflow) == 0 {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflow"})
	}
	body.WorkflowVersionID = strings.TrimSpace(body.WorkflowVersionID)
	if len(body.WorkflowVersionID) > 256 {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflowVersionId"})
	}
	wf, issues := domain.Parse(body.Workflow)
	if wf == nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "workflow." + contractField(issues)})
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(idempotencyKey) > 256 {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "Idempotency-Key"})
	}
	started, err := (runstart.Service{
		Engine: s.engine, Pool: s.pool, NewID: s.newID,
	}).Start(r.Context(), runstart.Request{
		OrgID: rc.orgID, CreatedBy: rc.userID, Workflow: wf,
		RequestedVersionID: body.WorkflowVersionID, Input: body.Input,
		IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		var rejection *runstart.Rejection
		if errors.As(err, &rejection) {
			switch rejection.Code {
			case runstart.CodeValidationFailed:
				result := opError(http.StatusBadRequest, rejection.Code,
					rejection.Message, map[string]any{"issues": rejection.Issues})
				result.unversionedExtras = map[string]any{"issues": rejection.Issues}
				return result
			case runstart.CodeNotProductionReady:
				return opError(http.StatusUnprocessableEntity, rejection.Code, rejection.Message, nil)
			case runstart.CodeCircuitPaused, runstart.CodeUpstreamDegraded:
				return opError(http.StatusConflict, rejection.Code, rejection.Message,
					map[string]any{"status": rejection.WorkflowStatus})
			case runstart.CodeVersionMismatch:
				return opError(http.StatusConflict, rejection.Code, rejection.Message, nil)
			case runstart.CodeAdhocDisabled:
				return opError(http.StatusForbidden, rejection.Code, rejection.Message, nil)
			}
		}
		var invalid *engine.InputValidationError
		if errors.As(err, &invalid) {
			return opError(http.StatusBadRequest, "runs_input_invalid",
				err.Error(), map[string]any{"errors": invalid.Errors})
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	// A duplicate idempotency key is success by definition. The original start
	// already owns its audit record, so replaying the response must not add one.
	if started.Replayed {
		return opOK(map[string]any{"runId": started.RunID})
	}
	isAdhoc := !started.Binding.Bound
	startAction := audit.Action("run.started")
	if isAdhoc {
		startAction = "run.started.adhoc"
	}
	audit.Write(r.Context(), s.pool, rc.authContext, startAction, audit.Options{
		TargetType: "run", TargetID: started.RunID,
		Metadata: map[string]any{
			"workflowId":        started.Workflow.ID,
			"workflowVersionId": started.Binding.VersionID, "adhoc": isAdhoc,
		},
	})
	return opOK(map[string]any{"runId": started.RunID})
}

const eventsPageDefault = 200

// getRun serves both /v1/run and /v1/status: the contract projects the
// same {run, nodes, events, eventsCursor, eventsHasMore} data for both.
func (s *V1Server) getRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.getRunCore(r, rc))
}

func (s *V1Server) getRunCore(r *http.Request, rc v1Request) opResult {
	runID := r.URL.Query().Get("runId")
	ctx := r.Context()
	q := store.New(s.pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: rc.orgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Unknown and cross-org are indistinguishable, per the golden.
			return opError(http.StatusForbidden, "runs_forbidden", "Forbidden", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	nodes, err := q.ListRunNodesByRun(ctx, runID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	hasMore := len(events) > limit
	if hasMore {
		events = events[:limit]
	}
	// The contract returns each page ASCENDING (paginateRunEvents reverses
	// the DESC rows), with the cursor pointing at the page's oldest event.
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	var nextCursor any
	if hasMore && len(events) > 0 {
		last := events[0]
		// Millisecond ISO, exactly the contract's toISOString shape — the
		// same precision events are WRITTEN at, so cursor comparisons are
		// exact for cursors minted by either backend.
		nextCursor = last.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z") + "|" + last.ID
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
	return opOK(map[string]any{
		"run":           runView(run),
		"nodes":         nodeViews,
		"events":        eventViews,
		"eventsCursor":  nextCursor,
		"eventsHasMore": hasMore,
	})
}

// runView emits the contract's full run key set; columns this backend does
// not populate yet surface as nulls, never as missing keys. The typed
// RunView makes a typo'd key a compile error.
func runView(run store.GetRunRow) RunView { return newRunView(run) }

func (s *V1Server) listRuns(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.listRunsCore(r, rc))
}

func (s *V1Server) listRunsCore(r *http.Request, rc v1Request) opResult {
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
			return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
				map[string]any{"field": "before"})
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	items := make([]RunSummaryView, 0, len(rows))
	for _, row := range rows {
		items = append(items, newRunSummaryView(row))
	}
	return opOK(items)
}

func (s *V1Server) resumeRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.resumeCore(r, rc))
}

func (s *V1Server) resumeCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		RunID       string         `json:"runId"`
		NodeID      string         `json:"nodeId"`
		Input       map[string]any `json:"input"`
		ResumeToken string         `json:"resumeToken"`
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if err := s.engine.ResumeRunWithInput(r.Context(), body.RunID, body.NodeID, body.Input, body.ResumeToken); err != nil {
		var inputErr *engine.InputValidationError
		switch {
		case errors.As(err, &inputErr):
			return opError(http.StatusBadRequest, "runs_input_validation_failed", "Input validation failed", nil)
		case errors.Is(err, engine.ErrResumeTokenRequired):
			return opError(http.StatusBadRequest, "runs_resume_token_required", "resumeToken is required", nil)
		case errors.Is(err, engine.ErrInvalidResumeToken):
			return opError(http.StatusForbidden, "runs_invalid_resume_token", "Invalid resume token", nil)
		case errors.Is(err, engine.ErrResumeConflict):
			return opError(http.StatusConflict, "runs_resume_conflict", "Node is not waiting", nil)
		case errors.Is(err, engine.ErrResumeNodeNotFound):
			return opError(http.StatusNotFound, "runs_resume_not_found", "Node not found", nil)
		default:
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "run.resumed", audit.Options{
		TargetType: "run", TargetID: body.RunID,
		Metadata: map[string]any{"nodeId": body.NodeID},
	})
	return opOK(map[string]any{"resumed": true})
}

func (s *V1Server) cancelRun(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.cancelCore(r, rc))
}

// cancelCore ports the contract guards exactly — and note the asymmetry
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
		if errors.Is(err, engine.ErrRunAlreadyTerminal) {
			// The pre-read above races the completion lock; the CAS is
			// authoritative. Re-read for an honest status in the message.
			status := "terminal"
			if owner, ownerErr := store.New(s.pool).GetRunOwner(r.Context(), body.RunID); ownerErr == nil {
				status = owner.Status
			}
			return opError(http.StatusConflict, "runs_already_terminal",
				"Run is already {{status}}; cannot cancel",
				map[string]any{"status": status})
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "run.cancelled", audit.Options{
		TargetType: "run", TargetID: body.RunID,
		Metadata: map[string]any{"reason": reason},
	})
	return opOK(map[string]any{"runId": body.RunID, "status": "cancelled"})
}

var deadLetterStatuses = map[string]bool{"open": true, "replayed": true, "resolved": true}

func (s *V1Server) listDeadLetters(w http.ResponseWriter, r *http.Request, rc v1Request) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	// Server-side filters, validated like the contract: an out-of-enum
	// status is a 400, not an empty page.
	status := r.URL.Query().Get("status")
	if status != "" && !deadLetterStatuses[status] {
		writeV1Error(w, rc.id, http.StatusBadRequest, "dlq_invalid_status", "Invalid DLQ status", nil)
		return
	}
	nodeID := r.URL.Query().Get("nodeId")
	workflowID := r.URL.Query().Get("workflowId")
	rows, err := store.New(s.pool).ListDeadLetterSummaries(r.Context(), store.ListDeadLetterSummariesParams{
		OrgID: rc.orgID, PageLimit: int32(limit),
		FilterStatus:     pgtype.Text{String: status, Valid: status != ""},
		FilterNodeID:     pgtype.Text{String: nodeID, Valid: nodeID != ""},
		FilterWorkflowID: pgtype.Text{String: workflowID, Valid: workflowID != ""},
	})
	if err != nil {
		s.internal(w, rc, err)
		return
	}
	// The ownership overlay travels with its dead letter (the contract
	// joins the same shape); the typed view owns the key set.
	items := make([]DeadLetterSummaryView, 0, len(rows))
	for _, row := range rows {
		items = append(items, newDeadLetterSummaryView(row))
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
	audit.Write(r.Context(), s.pool, rc.authContext, "dlq.replayed", audit.Options{
		TargetType: "dlq", TargetID: body.DeadLetterID,
	})
	writeV1Data(w, rc.id, map[string]any{"redriven": true})
}

// rollbackCore appends a prior snapshot as the new latest version with the
// contract's pre-checks: an active parent (a tombstone behaves as
// not-found for writes too), an org-and-workflow-scoped source version, a
// well-formed source DAG, and a version-increment conflict surfaced as a
// retryable 409.

func (s *V1Server) replayCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		DeadLetterID            string          `json:"deadLetterId"`
		RunID                   string          `json:"runId"`
		NodeID                  string          `json:"nodeId"`
		SuggestedWorkflow       json.RawMessage `json:"suggestedWorkflow"`
		RecoveryPlaybookID      string          `json:"recoveryPlaybookId"`
		RecoveryValidationRunID string          `json:"recoveryValidationRunId"`
	}
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "deadLetterId"})
	}
	if body.DeadLetterID == "" {
		// The exact-identity branch: the run panel replays {runId, nodeId}
		// without a dead-letter id (contract's second /dlq/replay form).
		if body.RunID == "" || body.NodeID == "" {
			return opError(http.StatusBadRequest, "dlq_fields_required", "runId and nodeId are required", nil)
		}
		if err := s.engine.RedriveRunNode(r.Context(), rc.orgID, body.RunID, body.NodeID); err != nil {
			switch {
			case errors.Is(err, engine.ErrDeadLetterNotFound):
				return opError(http.StatusForbidden, "dlq_forbidden", "Forbidden", nil)
			case errors.Is(err, engine.ErrRedriveConflict):
				return opError(http.StatusConflict, "dlq_replay_conflict",
					"This run can no longer be replayed — it was cancelled or already recovered", nil)
			default:
				return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
			}
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "dlq.replayed", audit.Options{
			TargetType: "run", TargetID: body.RunID,
			Metadata: map[string]any{"nodeId": body.NodeID},
		})
		return opOK(map[string]any{"ok": true})
	}
	if (body.RecoveryPlaybookID == "") != (body.RecoveryValidationRunID == "") {
		return opError(http.StatusBadRequest, "recovery_playbook_invalid_body",
			"recoveryPlaybookId and recoveryValidationRunId must be provided together", nil)
	}
	item, err := store.New(s.pool).GetDeadLetter(r.Context(), store.GetDeadLetterParams{
		ID: body.DeadLetterID, OrgID: rc.orgID,
	})
	if err != nil {
		return opError(http.StatusNotFound, "dlq_not_found", "Dead letter not found", nil)
	}
	var fix *domain.Workflow
	var fixJSON []byte
	if len(body.SuggestedWorkflow) > 0 && string(body.SuggestedWorkflow) != "null" {
		parsed, issues := domain.Parse(body.SuggestedWorkflow)
		if parsed == nil {
			reason := "unknown"
			if len(issues) > 0 {
				reason = issues[0].Message
			}
			return opError(http.StatusBadRequest, "dlq_workflow_schema_invalid",
				"suggestedWorkflow failed schema validation: "+reason, map[string]any{"reason": reason})
		}
		validation := domain.ValidateWithSemanticFixtures(parsed, grammar.DomainValidator, recovery.FixtureOutcomesForValidation)
		for _, issue := range validation.Issues {
			if issue.Code != domain.CodeNodeTypeNotExecutable {
				return opError(http.StatusBadRequest, "dlq_workflow_schema_invalid",
					"suggestedWorkflow failed schema validation: "+issue.Message,
					map[string]any{"reason": issue.Message})
			}
		}
		failingNodePresent := false
		for i := range parsed.Nodes {
			if parsed.Nodes[i].ID == item.NodeID {
				failingNodePresent = true
				break
			}
		}
		if !failingNodePresent {
			return opError(http.StatusBadRequest, "dlq_failing_node_missing",
				fmt.Sprintf("suggestedWorkflow does not contain the failing node id %q", item.NodeID),
				map[string]any{"nodeId": item.NodeID})
		}
		fix = parsed
		fixJSON, _ = json.Marshal(parsed)
	}
	if body.RecoveryPlaybookID != "" {
		if fix == nil || !s.engine.VerifyPlaybookReplayClaim(r.Context(), rc.orgID, item, fix,
			body.RecoveryPlaybookID, body.RecoveryValidationRunID) {
			return opError(http.StatusUnprocessableEntity, "recovery_playbook_outcome_invalid",
				"Recovery Playbook replay evidence cannot be verified", nil)
		}
	}
	if err := s.engine.RedriveDeadLetterWithOptions(r.Context(), rc.orgID, body.DeadLetterID,
		engine.RedriveOptions{
			PlaybookID: body.RecoveryPlaybookID, ValidationRunID: body.RecoveryValidationRunID,
			FixWorkflowJSON: fixJSON, RequestedBy: rc.userID,
		}); err != nil {
		switch {
		case errors.Is(err, engine.ErrDeadLetterNotFound):
			return opError(http.StatusNotFound, "dlq_not_found", "Dead letter not found", nil)
		case errors.Is(err, engine.ErrRedriveConflict):
			return opError(http.StatusConflict, "dlq_replay_conflict",
				"This run can no longer be replayed — it was cancelled or already recovered", nil)
		default:
			return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
		}
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "dlq.replayed", audit.Options{
		TargetType: "dlq", TargetID: body.DeadLetterID,
	})
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) replayAlias(w http.ResponseWriter, r *http.Request, rc v1Request) {
	writeVersioned(w, rc.id, s.replayCore(r, rc))
}
