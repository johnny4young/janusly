// The closed permission catalog, extracted from the reference
// (apps/api/src/permission-catalog.ts). 41 keys across 20 active
// categories; a parity test pins the exact key set so a catalog change
// upstream is a loud failure here, never silent drift. Adding a key means
// one entry plus its default roles — same contract as the reference.
package auth

// PermissionEntry mirrors the reference's catalog rows (descriptions stay
// with the reference; the pilot needs keys, categories, and defaults).
type PermissionEntry struct {
	Key          string
	Category     string
	DefaultRoles map[Role]bool
}

// PermissionCatalog is the closed set.
var PermissionCatalog = []PermissionEntry{
	{Key: "workflows.read", Category: "workflows", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "workflows.write", Category: "workflows", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "runs.read", Category: "runs", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "runs.start", Category: "runs", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "runs.cancel", Category: "runs", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "dlq.read", Category: "dlq", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "dlq.replay", Category: "dlq", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "recovery.read", Category: "recovery", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "recovery.write", Category: "recovery", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "reports.read", Category: "reports", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "reports.deliver", Category: "reports", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "ai.write", Category: "ai", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "members.read", Category: "members", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "members.write", Category: "members", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "members.role_set", Category: "members", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "org.config.write", Category: "org", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "org.permissions.write", Category: "org", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "mcp.connections.read", Category: "mcp", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "mcp.connections.write", Category: "mcp", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "autohealing.read", Category: "auto-healing", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "autohealing.decide", Category: "auto-healing", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "prompts.read", Category: "prompts", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "prompts.write", Category: "prompts", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "credentials.read", Category: "credentials", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "credentials.write", Category: "credentials", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "alerts.read", Category: "alerts", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "alerts.write", Category: "alerts", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "upstream.read", Category: "upstream", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "upstream.write", Category: "upstream", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "snippets.read", Category: "snippets", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "snippets.write", Category: "snippets", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "evals.read", Category: "evals", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "evals.write", Category: "evals", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "external-runtimes.read", Category: "external-runtimes", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "external-runtimes.write", Category: "external-runtimes", DefaultRoles: map[Role]bool{RoleAdmin: true}},
	{Key: "triggers.read", Category: "triggers", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "triggers.ingest", Category: "triggers", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "packs.read", Category: "packs", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "packs.install", Category: "packs", DefaultRoles: map[Role]bool{RoleEditor: true, RoleAdmin: true}},
	{Key: "onboarding.read", Category: "onboarding", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
	{Key: "onboarding.write", Category: "onboarding", DefaultRoles: map[Role]bool{RoleViewer: true, RoleEditor: true, RoleAdmin: true}},
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
