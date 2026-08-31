package mcpserver

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/ratelimit"
)

var defaultMCPReadPermissions = []string{
	"workflows.read", "runs.read", "dlq.read", "recovery.read",
}

func init() {
	audit.RegisterRuntimeAction("mcp.tool.invoked")
}

// ParsePermissionCeiling validates the explicit stdio service-account
// ceiling. An omitted value is intentionally read-only; write and AI
// authority must be named even when process and tenant write consent are on.
func ParsePermissionCeiling(raw string) (map[string]bool, error) {
	values := defaultMCPReadPermissions
	if strings.TrimSpace(raw) != "" {
		values = strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' })
	}
	permissions := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if !auth.IsPermission(value) {
			return nil, fmt.Errorf("unknown JANUSLY_MCP_PERMISSIONS entry %q", value)
		}
		permissions[value] = true
	}
	return permissions, nil
}

func PermissionKeys(permissions map[string]bool) []string {
	keys := make([]string, 0, len(permissions))
	for key, allowed := range permissions {
		if allowed {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

// guardTool is the common MCP authority envelope. Every invocation is
// permission checked, rate limited and audited; business writes additionally
// require both process opt-in and tenant consent.
func (d Deps) guardTool(ctx context.Context, toolName, permission string, write bool) (bool, string) {
	allowed := true
	reason := ""
	if d.OrgID == "" || d.UserID == "" {
		allowed = false
		reason = "MCP actor scope is unavailable."
	}
	maxCalls := 120
	if write {
		maxCalls = 60
	}
	if allowed && d.Limiter != nil {
		if err := d.Limiter.Enforce(ctx, d.OrgID, ratelimit.Options{
			Name: "mcp." + toolName, Max: maxCalls, Window: time.Minute,
		}); err != nil {
			allowed, reason = false, err.Error()
		}
	}
	if allowed && (d.Permissions == nil || !d.Permissions[permission]) {
		allowed = false
		reason = "MCP actor lacks permission " + permission + "."
	}
	if allowed && write && os.Getenv("JANUSLY_MCP_WRITES_ENABLED") != "true" {
		allowed = false
		reason = "MCP writes are disabled at the process level (JANUSLY_MCP_WRITES_ENABLED is not 'true')."
	}
	if allowed && write {
		if d.Pool == nil {
			allowed = false
			reason = "MCP write consent cannot be verified because the tenant store is unavailable."
		} else if !orgconfig.LoadBool(ctx, d.Pool, d.OrgID, "mcp.writeConsent") {
			allowed = false
			reason = "MCP writes are not consented for this organization (mcp.writeConsent is false)."
		}
	}
	d.auditToolDecision(ctx, toolName, []string{permission}, write, allowed, reason, "guard")
	return allowed, reason
}

// requireAdditionalPermissions enforces immutable-candidate authority after
// the primary recovery.write guard has already established tenant scope and
// consent. This is deliberately separate: the required set is content-bound
// and cannot be known until the candidate artifact is read.
func (d Deps) requireAdditionalPermissions(
	ctx context.Context,
	toolName string,
	permissions []string,
) (bool, string) {
	missing := make([]string, 0, len(permissions))
	seen := map[string]bool{}
	for _, permission := range permissions {
		if permission == "" || seen[permission] {
			continue
		}
		seen[permission] = true
		if d.Permissions == nil || !d.Permissions[permission] {
			missing = append(missing, permission)
		}
	}
	if len(missing) == 0 {
		return true, ""
	}
	sort.Strings(missing)
	reason := "MCP actor lacks candidate permission " + strings.Join(missing, ", ") + "."
	d.auditToolDecision(ctx, toolName, missing, true, false, reason, "candidate_permissions")
	return false, reason
}

func (d Deps) auditToolDecision(
	ctx context.Context,
	toolName string,
	permissions []string,
	write bool,
	allowed bool,
	reason string,
	phase string,
) {
	// A nil pool is possible in schema-only unit tests. Never turn optional
	// telemetry into a panic; production always supplies the runtime pool.
	if d.Pool == nil {
		return
	}
	audit.Write(ctx, d.Pool, d.auditContext(), "mcp.tool.invoked", audit.Options{
		TargetType: "mcp_tool", TargetID: toolName,
		Metadata: map[string]any{
			"permissions": permissions, "write": write, "allowed": allowed,
			"denial": reason, "phase": phase,
		},
	})
}
