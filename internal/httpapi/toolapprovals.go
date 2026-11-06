package httpapi

import (
	"errors"
	"net/http"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/engine"
)

func init() {
	audit.RegisterRuntimeAction("tool_approval.approved")
	audit.RegisterRuntimeAction("tool_approval.denied")
}

func (s *V1Server) mountToolApprovalRoutes(mux *http.ServeMux) {
	s.route(mux, "POST /runs/tool-approvals/decide", routeGate{auth.RoleEditor, "runs.start"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.decideToolApprovalCore(r, rc))
	})
}

// decideToolApprovalCore records a person's decision; automation cannot approve.
func (s *V1Server) decideToolApprovalCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		ApprovalID   string `json:"approvalId"`
		ParamsDigest string `json:"paramsDigest"`
		Decision     string `json:"decision"`
	}
	status := map[string]string{"approve": engine.ToolApprovalApproved, "deny": engine.ToolApprovalDenied}
	if err := decodeBody(r, &body); err != nil || body.ApprovalID == "" || body.ParamsDigest == "" || status[body.Decision] == "" {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	if rc.authContext == nil || rc.authContext.Mode == auth.ModeServiceToken || rc.authContext.UserID == "" {
		return opError(http.StatusForbidden, "tool_approval_human_required", "Only a person can decide a tool approval", nil)
	}
	row, replayed, err := s.engine.DecideToolApproval(r.Context(), engine.ToolApprovalDecision{
		OrgID: rc.orgID, ApprovalID: body.ApprovalID, Actor: rc.authContext.UserID,
		ParamsDigest: body.ParamsDigest, Status: status[body.Decision],
	})
	switch {
	case errors.Is(err, engine.ErrToolApprovalNotFound):
		return opError(http.StatusNotFound, "tool_approval_not_found", err.Error(), nil)
	case errors.Is(err, engine.ErrToolApprovalSelf):
		return opError(http.StatusForbidden, "tool_approval_self", err.Error(), nil)
	case errors.Is(err, engine.ErrToolApprovalStale):
		return opError(http.StatusConflict, "tool_approval_stale", err.Error(), nil)
	case errors.Is(err, engine.ErrToolApprovalConflict):
		return opError(http.StatusConflict, "tool_approval_conflict", err.Error(), nil)
	case err != nil:
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if !replayed {
		s.audit.Write(r.Context(), s.pool, rc.authContext, audit.Action("tool_approval."+status[body.Decision]), audit.Options{
			TargetType: "run", TargetID: row.RunID,
			Metadata: map[string]any{
				"approvalId": row.ID, "nodeId": row.NodeID, "tool": row.Tool, "paramsDigest": row.ParamsDigest,
			},
		})
	}
	return opOK(map[string]any{"runId": row.RunID, "decision": body.Decision})
}

// toolApprovalDropped maps the engine's refusal to run a gated step without its gate.
func toolApprovalDropped(err error) (opResult, bool) {
	var dropped *engine.ToolApprovalDroppedError
	if !errors.As(err, &dropped) {
		return opResult{}, false
	}
	return opError(http.StatusConflict, "tool_approval_dropped", dropped.Error(), map[string]any{"nodeId": dropped.NodeID}), true
}
