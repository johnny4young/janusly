package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

func init() {
	audit.RegisterRuntimeAction("tool_approval.approved")
	audit.RegisterRuntimeAction("tool_approval.denied")
}

func (s *V1Server) mountToolApprovalRoutes(mux *http.ServeMux) {
	s.route(mux, "POST /org/tool-approval-policy", routeGate{auth.RoleAdmin, "org.config.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.setToolApprovalPolicyCore(r, rc))
	})
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
	if rc.authContext == nil || !auth.IsPersonMode(rc.authContext.Mode) || rc.authContext.UserID == "" {
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

// servicePrincipal names the service token behind a request, if any.
func servicePrincipal(rc v1Request) string {
	if rc.authContext != nil && rc.authContext.Mode == auth.ModeServiceToken {
		return engine.ApprovalActorID(rc.authContext)
	}
	return ""
}

// setToolApprovalPolicyCore adds or removes one tool under a per-org lock, so
// two admins editing at once never drop each other's entries.
func (s *V1Server) setToolApprovalPolicyCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Tool     string `json:"tool"`
		Required *bool  `json:"required"`
	}
	if err := decodeBody(r, &body); err != nil || body.Required == nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	if name := unenforceableApprovalTool(orgconfig.ToolApprovalPolicyKey, body.Tool); name != "" || body.Tool == "" {
		return opError(http.StatusBadRequest, "tool_approval_unenforceable",
			fmt.Sprintf("Approval cannot be enforced for %q yet; only built-in tools and http requests can require it", body.Tool), nil)
	}
	def := orgconfig.Get(orgconfig.ToolApprovalPolicyKey)
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	if err := q.AcquireRunCompletionLock(ctx, "org-config:"+rc.orgID+":"+def.Key); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	current := ""
	if raw, err := q.GetOrgConfigValue(ctx, store.GetOrgConfigValueParams{OrgID: rc.orgID, Key: def.Key}); err == nil {
		_ = json.Unmarshal(raw, &current)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	names, err := orgconfig.ParseToolApprovalPolicy(current)
	if err != nil {
		names = map[string]bool{}
	}
	if *body.Required {
		names[body.Tool] = true
	} else {
		delete(names, body.Tool)
	}
	listed := slices.Sorted(maps.Keys(names))
	value := strings.Join(listed, ", ")
	if _, err := orgconfig.Normalize(def, value); err != nil {
		return opError(http.StatusBadRequest, "org_config_invalid", err.Error(), nil)
	}
	valueJSON, _ := json.Marshal(value)
	if err := q.UpsertOrgConfigValue(ctx, store.UpsertOrgConfigValueParams{
		ID: s.newID(), OrgID: rc.orgID, Key: def.Key, ValueJson: valueJSON,
		Category: def.Category, Description: def.Description, ValueType: def.ValueType,
		UpdatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if err := tx.Commit(ctx); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	s.audit.Write(ctx, s.pool, rc.authContext, "org.config.updated", audit.Options{
		TargetType: "org_config", TargetID: def.Key,
		Metadata: map[string]any{"key": def.Key, "value": value, "tool": body.Tool, "required": *body.Required},
	})
	return opOK(map[string]any{"tools": listed})
}
