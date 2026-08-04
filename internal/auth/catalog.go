// The closed permission catalog, extracted from the contract
// (the API contract). 41 keys across 20 active
// categories; a consistency test pins the exact key set so a catalog change
// upstream is a loud failure here, never silent drift. Adding a key means
// one entry plus its default roles — same contract as the contract.
package auth

// PermissionEntry mirrors the contract's catalog rows (descriptions stay
// with the contract; the runtime needs keys, categories, and defaults).
type PermissionEntry struct {
	Key          string
	Category     string
	Description  string
	DefaultRoles map[Role]bool
}

// PermissionCatalog is the closed set.
var PermissionCatalog = []PermissionEntry{
	{Key: "workflows.read", Category: "workflows", Description: "View workflows + versions + health", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "workflows.write", Category: "workflows", Description: "Save / validate / rollback workflows", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "runs.read", Category: "runs", Description: "View runs and run history", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "runs.start", Category: "runs", Description: "Start runs via /start", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "runs.cancel", Category: "runs", Description: "Cancel an in-flight run", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "dlq.read", Category: "dlq", Description: "View DLQ entries + clusters", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "dlq.replay", Category: "dlq", Description: "Replay a dead-lettered run/node", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "recovery.read", Category: "recovery", Description: "View recovery metrics + delta", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "recovery.write", Category: "recovery", Description: "Submit recovery feedback, manage recovery items (acknowledge / resolve / comment / escalate)", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "reports.read", Category: "reports", Description: "Download run and value reports", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "reports.deliver", Category: "reports", Description: "Deliver run-explain via Slack / GitHub / webhook", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "ai.write", Category: "ai", Description: "Use AI generate / patch / suggest / explain", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "members.read", Category: "members", Description: "View members + invitations", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "members.write", Category: "members", Description: "Invite, remove, and change member roles", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "members.role_set", Category: "members", Description: "Change a member's role specifically", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "org.config.write", Category: "org", Description: "Edit org-level configuration (budget, auth policies, …)", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "org.permissions.write", Category: "org", Description: "Manage permission catalog overrides + custom roles", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "mcp.connections.read", Category: "mcp", Description: "View external MCP server connections + cached tool descriptors", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "mcp.connections.write", Category: "mcp", Description: "Register / edit / delete external MCP server connections + enable per-tool descriptors", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "autohealing.read", Category: "auto-healing", Description: "View pending supervised auto-healing decisions", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "autohealing.decide", Category: "auto-healing", Description: "Apply or decline a pending auto-healing decision; trigger ad-hoc scans (admin only)", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "prompts.read", Category: "prompts", Description: "View prompts + versions in the PromptOps registry", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "prompts.write", Category: "prompts", Description: "Create prompts, append new versions, pin active version", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "credentials.read", Category: "credentials", Description: "View credentials + credential / MCP connection health", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "credentials.write", Category: "credentials", Description: "Register / edit / delete credentials", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "alerts.read", Category: "alerts", Description: "View alert policies and recently fired alerts", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "alerts.write", Category: "alerts", Description: "Create / edit / delete recovery alerting policies", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "upstream.read", Category: "upstream", Description: "View upstream health sources + derived status", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "upstream.write", Category: "upstream", Description: "Register / edit / delete upstream health sources", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "snippets.read", Category: "snippets", Description: "View built-in + org-private workflow snippets", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "snippets.write", Category: "snippets", Description: "Create / edit / delete org-private workflow snippets", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "evals.read", Category: "evals", Description: "View + export eval datasets built from recovery decisions", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "evals.write", Category: "evals", Description: "Create / delete eval datasets from opted-in recovery feedback", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "external-runtimes.read", Category: "external-runtimes", Description: "View external runtime connections and read-only lifecycle projections", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "external-runtimes.write", Category: "external-runtimes", Description: "Register / edit / delete signed external runtime observers", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "triggers.read", Category: "triggers", Description: "View structured inbound-trigger events + replay history", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "triggers.ingest", Category: "triggers", Description: "Submit a normalized inbound trigger event (relay / forwarder)", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "packs.read", Category: "packs", Description: "View the solution-pack catalog + per-org dependency hints", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "packs.install", Category: "packs", Description: "Install a pack as a draft workflow, run a sandbox sample, or start a recovery drill", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "onboarding.read", Category: "onboarding", Description: "View own onboarding checklist progress", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "onboarding.write", Category: "onboarding", Description: "Skip or resume own onboarding checklist", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
}

// permissionsByKey indexes the catalog for O(1) checks.
var permissionsByKey = func() map[string]PermissionEntry {
	byKey := make(map[string]PermissionEntry, len(PermissionCatalog))
	for _, entry := range PermissionCatalog {
		byKey[entry.Key] = entry
	}
	return byKey
}()

// IsPermission reports catalog membership.
func IsPermission(key string) bool {
	_, ok := permissionsByKey[key]
	return ok
}

// DefaultRoleHasPermission answers the built-in grant matrix.
func DefaultRoleHasPermission(role Role, key string) bool {
	entry, ok := permissionsByKey[key]
	return ok && entry.DefaultRoles[role]
}

// MandatoryAdminPermissions is the self-lockout floor: any override of the
// BUILT-IN admin role force-includes these, so an admin cannot strip the
// org's ability to manage permissions and members.
func MandatoryAdminPermissions() []string {
	return []string{"org.permissions.write", "members.write"}
}

// CoerceAdminFloor applies the floor to an override of `roleName`,
// returning the merged set plus the keys that were coerced in (the audit
// records them under metadata.coerced). Custom roles that merely INHERIT
// admin rank are deliberately not coerced — the contract's billing-admin
// case, a deliberate narrow admin.
func CoerceAdminFloor(roleName string, permissions []string) (merged, coerced []string) {
	if roleName != string(RoleAdmin) {
		return permissions, nil
	}
	merged = append([]string{}, permissions...)
	present := map[string]bool{}
	for _, key := range merged {
		present[key] = true
	}
	for _, required := range MandatoryAdminPermissions() {
		if !present[required] {
			merged = append(merged, required)
			coerced = append(coerced, required)
		}
	}
	return merged, coerced
}
