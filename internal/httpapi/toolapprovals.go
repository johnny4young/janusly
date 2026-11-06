package httpapi

import (
	"errors"
	"maps"
	"net/http"
	"slices"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/orgconfig"
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

// unenforceableApprovalTool names a listed tool the gate cannot hold, such as
// an MCP tool, so the policy never promises a gate that does not exist.
func unenforceableApprovalTool(key string, value any) string {
	text, _ := value.(string)
	if key != orgconfig.ToolApprovalPolicyKey {
		return ""
	}
	names, _ := orgconfig.ParseToolApprovalPolicy(text)
	for _, name := range slices.Sorted(maps.Keys(names)) {
		if !executors.SharedToolRegistry().Has(name) {
			return name
		}
	}
	return ""
}
