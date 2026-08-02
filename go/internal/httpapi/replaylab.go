// Replay Lab routes (T-517; reference run-routes/replay-lab.ts): the
// whole-run sandbox replay (optionally with a patched workflow) and the
// targeted fork. Editor + runs.start, "ai" rate family, org-scoped
// source with identical 404s (no enumeration leak), nested labs
// rejected, and the reference's exact error-code ladder.
package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/johnny4young/janusly/go/internal/aiconfig"
	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/ratelimit"
	"github.com/johnny4young/janusly/go/internal/store"
)

const replayLabOverrideMaxBytes = 64_000

// resolveLabSnapshot loads the source run's workflow: saved
// workflow_versions.dagJson first, ad-hoc runs.inputJson.workflow as the
// fallback. Also returns the source's trigger-time input for propagation.
func (s *V1Server) resolveLabSnapshot(r *http.Request, rc v1Request, run store.GetRunRow) (*domain.Workflow, any, *opResult) {
	q := store.New(s.pool)
	var snapshot []byte
	if version, err := q.GetWorkflowVersionByID(r.Context(), store.GetWorkflowVersionByIDParams{
		ID: run.WorkflowVersionID, OrgID: rc.orgID,
	}); err == nil && len(version.DagJson) > 0 {
		snapshot = version.DagJson
	}
	var envelope struct {
		Workflow json.RawMessage `json:"workflow"`
		Input    any             `json:"input"`
	}
	_ = json.Unmarshal(run.InputJson, &envelope)
	if len(snapshot) == 0 {
		snapshot = envelope.Workflow
	}
	if len(snapshot) == 0 || string(snapshot) == "null" {
		failed := opError(http.StatusBadRequest, "no_workflow_snapshot",
			"Source run has no workflow snapshot available", nil)
		return nil, nil, &failed
	}
	wf, issues := domain.Parse(snapshot)
	if wf == nil {
		reason := "unknown"
		if len(issues) > 0 {
			reason = issues[0].Message
		}
		failed := opError(http.StatusBadRequest, "invalid_snapshot",
			"Source run snapshot failed schema validation: {{reason}}", map[string]any{"reason": reason})
		return nil, nil, &failed
	}
	return wf, envelope.Input, nil
}

// labSource org-scopes the source run and rejects nested sandboxes.
func (s *V1Server) labSource(r *http.Request, rc v1Request, sourceRunID, notFoundCode string) (store.GetRunRow, *opResult) {
	run, err := store.New(s.pool).GetRun(r.Context(), store.GetRunParams{ID: sourceRunID, OrgID: rc.orgID})
	if err != nil {
		failed := opError(http.StatusNotFound, notFoundCode, "Source run not found", nil)
		return store.GetRunRow{}, &failed
	}
	if run.ReplayMode.Valid && run.ReplayMode.String != "" {
		failed := opError(http.StatusBadRequest, "nested_replay_lab",
			"Source run is itself a sandbox run; cannot start a nested lab", nil)
		return store.GetRunRow{}, &failed
	}
	return run, nil
}

func (s *V1Server) labRateLimit(r *http.Request, rc v1Request) *opResult {
	_, settings := aiconfig.Resolve(r.Context(), s.pool, rc.orgID)
	if err := s.limiter.Enforce(r.Context(), rc.orgID, ratelimit.Options{
		Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
	}); err != nil {
		failed := opError(http.StatusTooManyRequests, "rate_limited", err.Error(), nil)
		return &failed
	}
	return nil
}

func (s *V1Server) replayLabCore(r *http.Request, rc v1Request) opResult {
	if rejection := s.labRateLimit(r, rc); rejection != nil {
		return *rejection
	}
	var body struct {
		SourceRunID       string          `json:"sourceRunId"`
		SuggestedWorkflow json.RawMessage `json:"suggestedWorkflow"`
	}
	if err := decodeBody(r, &body); err != nil || body.SourceRunID == "" {
		return opError(http.StatusBadRequest, "runs_source_run_id_required", "sourceRunId is required", nil)
	}
	run, rejection := s.labSource(r, rc, body.SourceRunID, "runs_source_run_not_found")
	if rejection != nil {
		return *rejection
	}

	hasPatch := len(body.SuggestedWorkflow) > 0 && string(body.SuggestedWorkflow) != "null"
	var wf *domain.Workflow
	var triggerInput any
	if hasPatch {
		var probe any
		if json.Unmarshal(body.SuggestedWorkflow, &probe) != nil {
			return opError(http.StatusBadRequest, "runs_suggested_workflow_not_object", "suggestedWorkflow must be an object", nil)
		}
		if _, ok := probe.(map[string]any); !ok {
			return opError(http.StatusBadRequest, "runs_suggested_workflow_not_object", "suggestedWorkflow must be an object", nil)
		}
		parsed, issues := domain.Parse(body.SuggestedWorkflow)
		if parsed == nil {
			reason := "unknown"
			if len(issues) > 0 {
				reason = issues[0].Message
			}
			return opError(http.StatusBadRequest, "runs_suggested_workflow_invalid",
				"suggestedWorkflow failed schema validation: {{reason}}", map[string]any{"reason": reason})
		}
		if blocking := validateGeneratedWorkflow(body.SuggestedWorkflow); len(blocking) > 0 {
			return opError(http.StatusBadRequest, "runs_suggested_workflow_sanitize_failed",
				"suggestedWorkflow sanitize failed: {{reason}}", map[string]any{"reason": blocking[0].Message})
		}
		wf = parsed
		var envelope struct {
			Input any `json:"input"`
		}
		_ = json.Unmarshal(run.InputJson, &envelope)
		triggerInput = envelope.Input
	} else {
		var failed *opResult
		wf, triggerInput, failed = s.resolveLabSnapshot(r, rc, run)
		if failed != nil {
			return *failed
		}
	}

	replayRunID, err := s.engine.ReplayRunAsValidation(r.Context(), rc.orgID, body.SourceRunID, wf, triggerInput, rc.userID, hasPatch)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "replay_lab.started", audit.Options{
		TargetType: "run", TargetID: body.SourceRunID,
		Metadata: map[string]any{"replayRunId": replayRunID, "hasPatch": hasPatch},
	})
	return opOK(map[string]any{"runId": replayRunID})
}

func (s *V1Server) replayLabForkCore(r *http.Request, rc v1Request) opResult {
	if rejection := s.labRateLimit(r, rc); rejection != nil {
		return *rejection
	}
	var body struct {
		SourceRunID   string          `json:"sourceRunId"`
		ForkNodeID    string          `json:"forkNodeId"`
		InputOverride json.RawMessage `json:"inputOverride"`
	}
	if err := decodeBody(r, &body); err != nil || body.SourceRunID == "" {
		return opError(http.StatusBadRequest, "invalid_input", "sourceRunId is required", nil)
	}
	if body.ForkNodeID == "" {
		return opError(http.StatusBadRequest, "invalid_input", "forkNodeId is required", nil)
	}
	var override any
	if len(body.InputOverride) > 0 && string(body.InputOverride) != "null" {
		if len(body.InputOverride) > replayLabOverrideMaxBytes {
			return opError(http.StatusUnprocessableEntity, "override_too_large",
				"inputOverride exceeds 64 KiB cap ({{overrideBytes}} bytes)",
				map[string]any{"overrideBytes": len(body.InputOverride)})
		}
		if json.Unmarshal(body.InputOverride, &override) != nil {
			return opError(http.StatusBadRequest, "invalid_input", "inputOverride must be valid JSON", nil)
		}
	}
	run, rejection := s.labSource(r, rc, body.SourceRunID, "not_found")
	if rejection != nil {
		return *rejection
	}
	// v1 forks replay the source's OWN snapshot (patches go through the
	// whole-run lab so validation covers the full DAG).
	wf, triggerInput, failed := s.resolveLabSnapshot(r, rc, run)
	if failed != nil {
		return *failed
	}
	result, err := s.engine.ReplayRunAsValidationFork(r.Context(), rc.orgID, body.SourceRunID, wf, body.ForkNodeID, override, triggerInput, rc.userID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if !result.OK {
		return opError(http.StatusUnprocessableEntity, result.Code, result.Message, nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "replay_lab.fork_started", audit.Options{
		TargetType: "run", TargetID: body.SourceRunID,
		Metadata: map[string]any{
			"replayRunId": result.RunID, "forkNodeId": body.ForkNodeID,
			"predecessorCount": result.PredecessorCount, "hasOverride": override != nil,
		},
	})
	return opOK(map[string]any{"runId": result.RunID, "predecessorCount": result.PredecessorCount})
}

func (s *V1Server) mountReplayLabRoutes(mux *http.ServeMux) {
	s.route(mux, "POST /runs/replay-lab", routeGate{auth.RoleEditor, "runs.start"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.replayLabCore(r, rc))
	})
	s.route(mux, "POST /runs/replay-lab/fork", routeGate{auth.RoleEditor, "runs.start"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.replayLabForkCore(r, rc))
	})
}
