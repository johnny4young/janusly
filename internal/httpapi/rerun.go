// Rerun from a step (engine/rerun.go): the preview lists what would reuse, run
// again and change external state; the start needs those side effects
// acknowledged and enters through the same admission path as any run start.
package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/runstart"
	"github.com/johnny4young/janusly/internal/store"
)

func init() { audit.RegisterRuntimeAction("run.rerun_started") }

type rerunRequest struct {
	SourceRunID             string          `json:"sourceRunId"`
	NodeID                  string          `json:"nodeId"`
	InputOverride           json.RawMessage `json:"inputOverride"`
	AcknowledgedSideEffects []string        `json:"acknowledgedSideEffects"`
}

type preparedRerun struct {
	run      store.GetRunRow
	original *domain.Workflow
	workflow *domain.Workflow
	input    any
	plan     engine.RerunPlan
}

func rerunRejected(rejection *engine.RerunRejection) opResult {
	status := http.StatusUnprocessableEntity
	if rejection.Code == "rerun_source_open" {
		status = http.StatusConflict
	}
	return opError(status, rejection.Code, rejection.Message, map[string]any{"nodeId": rejection.NodeID})
}

// rerunIdempotencyKey binds the client's key to this request, so a resubmit after
// a lost response replays the same rerun but an edited one starts its own.
func rerunIdempotencyKey(key string, body rerunRequest) string {
	if key == "" {
		return ""
	}
	sum := sha256.New()
	for _, part := range [][]byte{[]byte(key), []byte(body.SourceRunID), []byte(body.NodeID), body.InputOverride} {
		_, _ = fmt.Fprintf(sum, "%d:%s", len(part), part)
	}
	return "rerun:" + hex.EncodeToString(sum.Sum(nil))
}

func (s *V1Server) prepareRerun(r *http.Request, rc v1Request, body rerunRequest) (preparedRerun, *opResult) {
	var override map[string]any
	fail := func(result opResult) (preparedRerun, *opResult) { return preparedRerun{}, &result }
	if body.SourceRunID == "" || body.NodeID == "" {
		return fail(opError(http.StatusBadRequest, "invalid_input", "sourceRunId and nodeId are required", nil))
	}
	if len(body.InputOverride) > replayLabOverrideMaxBytes {
		return fail(opError(http.StatusUnprocessableEntity, "override_too_large",
			"inputOverride exceeds 64 KiB cap ({{overrideBytes}} bytes)",
			map[string]any{"overrideBytes": len(body.InputOverride)}))
	}
	prepared := preparedRerun{}
	if len(body.InputOverride) > 0 && string(body.InputOverride) != "null" {
		if json.Unmarshal(body.InputOverride, &override) != nil || override == nil {
			return fail(opError(http.StatusBadRequest, "invalid_input", "inputOverride must be a JSON object", nil))
		}
	}
	run, rejection := s.labSource(r, rc, body.SourceRunID, "not_found")
	if rejection != nil {
		return preparedRerun{}, rejection
	}
	link, err := store.New(s.pool).GetRunParentLink(r.Context(), run.ID)
	if err != nil {
		return fail(opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
	}
	// The child's writes rest on its parent's approvals and input.
	if link.ParentRunID.Valid && (link.ParentLinkKind.String == "subworkflow" || (!link.ParentLinkKind.Valid && !link.ReplayMode.Valid)) {
		return fail(opError(http.StatusUnprocessableEntity, "rerun_subworkflow_child", "Rerun this from its parent run", nil))
	}
	switch run.Status {
	case "succeeded", "failed", "cancelled", "timed_out":
	default:
		// Saved outputs are not settled, and the source could still run the effects.
		return fail(opError(http.StatusConflict, "rerun_source_open", "The source run has not finished", nil))
	}
	wf, input, err := engine.RunSnapshot(run.InputJson)
	if err != nil {
		return fail(opError(http.StatusBadRequest, "invalid_snapshot", "Source run snapshot failed schema validation", nil))
	}
	prepared.run, prepared.original, prepared.workflow = run, wf, wf
	if input != nil {
		prepared.input = input
	}
	if override != nil {
		patched, refused := engine.ApplyRerunOverride(wf, body.NodeID, override)
		if refused != nil {
			return fail(rerunRejected(refused))
		}
		prepared.workflow = patched
	}
	rows, err := store.New(s.pool).ListRunNodesByRunForOrg(r.Context(), store.ListRunNodesByRunForOrgParams{
		RunID: body.SourceRunID, OrgID: rc.orgID,
	})
	if err != nil {
		return fail(opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
	}
	plan, refused := engine.PlanRerun(body.SourceRunID, prepared.workflow, rows, body.NodeID)
	if refused != nil {
		return fail(rerunRejected(refused))
	}
	prepared.plan = plan
	return prepared, nil
}

func (s *V1Server) rerunPreviewCore(r *http.Request, rc v1Request) opResult {
	var body rerunRequest
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	prepared, rejection := s.prepareRerun(r, rc, body)
	if rejection != nil {
		return *rejection
	}
	var input any = map[string]any{}
	for _, node := range prepared.original.Nodes {
		if node.ID == body.NodeID && node.Config != nil {
			input = grammar.RedactSensitiveKeys(node.Config)
		}
	}
	return opOK(map[string]any{
		"input": input, "reused": prepared.plan.Reused, "rerun": prepared.plan.Rerun,
		"notRun": prepared.plan.NotRun, "sideEffects": prepared.plan.SideEffects,
	})
}

// rerunVersion keeps the source's version only while the document still equals
// it; an override makes the run honestly unbound, which saved-only tenants refuse.
func (s *V1Server) rerunVersion(ctx context.Context, orgID string, prepared preparedRerun) string {
	binding, err := s.engine.ResolveWorkflowVersionBinding(ctx, orgID, prepared.workflow, prepared.run.WorkflowVersionID)
	if err != nil || !binding.Bound {
		return ""
	}
	return binding.VersionID
}

func (s *V1Server) rerunStartCore(r *http.Request, rc v1Request) opResult {
	if err := s.limiter.Enforce(r.Context(), rc.orgID, s.startRunLimit); err != nil {
		return limitedResult(err)
	}
	var body rerunRequest
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(idempotencyKey) > 256 {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body",
			map[string]any{"field": "Idempotency-Key"})
	}
	prepared, rejection := s.prepareRerun(r, rc, body)
	if rejection != nil {
		return *rejection
	}
	// Recomputed from the document that will run, so an edit that turns a read
	// into a write comes back for confirmation instead of slipping through.
	for _, effect := range prepared.plan.SideEffects {
		if !slices.Contains(body.AcknowledgedSideEffects, effect.NodeID) {
			return opError(http.StatusConflict, "rerun_side_effects_unconfirmed",
				"Confirm the steps with side effects before rerunning",
				map[string]any{"sideEffects": prepared.plan.SideEffects})
		}
	}
	started, err := (runstart.Service{Engine: s.engine, Pool: s.pool, NewID: s.newID}).Start(r.Context(), runstart.Request{
		OrgID: rc.orgID, CreatedBy: rc.userID, Workflow: prepared.workflow,
		RequestedVersionID: s.rerunVersion(r.Context(), rc.orgID, prepared),
		Input:              prepared.input, IdempotencyKey: rerunIdempotencyKey(idempotencyKey, body), Rerun: prepared.plan.Seed,
	})
	if errors.Is(err, engine.ErrRerunSourceOpen) {
		return opError(http.StatusConflict, "rerun_source_open", "The source run has not finished", nil)
	}
	if err != nil {
		return runStartFailure(err)
	}
	if started.Replayed {
		return opOK(map[string]any{"runId": started.RunID})
	}
	// Override values never reach the audit trail.
	s.audit.Write(r.Context(), s.pool, rc.authContext, "run.rerun_started", audit.Options{
		TargetType: "run", TargetID: started.RunID,
		Metadata: map[string]any{
			"sourceRunId": body.SourceRunID, "nodeId": body.NodeID,
			"inputEdited":       prepared.workflow != prepared.original,
			"reused":            prepared.plan.Reused,
			"sideEffects":       prepared.plan.SideEffects,
			"workflowVersionId": started.Binding.VersionID,
		},
	})
	return opOK(map[string]any{"runId": started.RunID})
}

func (s *V1Server) mountRerunRoutes(mux *http.ServeMux) {
	s.route(mux, "POST /runs/rerun/preview", routeGate{auth.RoleEditor, "runs.start"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.rerunPreviewCore(r, rc))
	})
	s.route(mux, "POST /runs/rerun", routeGate{auth.RoleEditor, "runs.start"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.rerunStartCore(r, rc))
	})
}
