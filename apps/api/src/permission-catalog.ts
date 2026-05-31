/**
 * Fine-grained permission catalog for organization role authorization.
 *
 * Each entry maps an explicit action (e.g. `dlq.replay`) to:
 *   - a human-readable description (surfaced in the admin UI)
 *   - the category it belongs to (UI grouping)
 *   - the closed set of built-in roles that grant the permission by
 *     default (`defaultRoles`).
 *
 * Per-org overrides live in `org_roles.grantedPermissions` (JSONB
 * array of these keys). When no row exists for `(orgId, "editor")`
 * with non-null `grantedPermissions`, the resolver falls back to the
 * catalog defaults below.
 *
 * Adding a new permission means adding one entry to
 * `PERMISSION_CATALOG` plus its default role assignment. Roles that
 * existed at the time an org's override was saved DON'T automatically
 * get the new permission — the admin must re-save to opt in. The
 * admin UI surfaces a "X new permissions added since you last saved"
 * pill on affected roles.
 *
 * Used by:
 * - `apps/api/src/permissions.ts` (`getEffectivePermissions`,
 *   `requirePermission`).
 * - `apps/api/src/routes/roles-routes.ts` (catalog + roles CRUD).
 * - `apps/web/src/components/PermissionGrantsPanel.tsx` (admin UI).
 */

import type { Role } from "./permissions";

export type PermissionCategory =
  | "workflows"
  | "runs"
  | "dlq"
  | "recovery"
  | "reports"
  | "ai"
  | "members"
  | "org"
  | "plugins"
  | "mcp"
  | "prompts"
  | "auto-healing"
  | "credentials"
  | "alerts"
  | "upstream"
  | "snippets"
  | "evals"
  | "triggers"
  | "packs"
  | "onboarding";

export type PermissionEntry = {
  key: string;
  category: PermissionCategory;
  description: string;
  defaultRoles: readonly Role[];
};

/**
 * Closed catalog of permission keys. Currently 39 keys across 19
 * categories. Mirrors the action categories exposed by the API surface
 * today.
 */
export const PERMISSION_CATALOG = [
  // workflows
  { key: "workflows.read",       category: "workflows", description: "View workflows + versions + health",       defaultRoles: ["viewer", "editor", "admin"] },
  { key: "workflows.write",      category: "workflows", description: "Save / validate / rollback workflows",     defaultRoles: ["editor", "admin"] },
  // runs
  { key: "runs.read",            category: "runs",      description: "View runs and run history",                defaultRoles: ["viewer", "editor", "admin"] },
  { key: "runs.start",           category: "runs",      description: "Start runs via /start",                    defaultRoles: ["editor", "admin"] },
  { key: "runs.cancel",          category: "runs",      description: "Cancel an in-flight run",                  defaultRoles: ["editor", "admin"] },
  // dlq
  { key: "dlq.read",             category: "dlq",       description: "View DLQ entries + clusters",              defaultRoles: ["viewer", "editor", "admin"] },
  { key: "dlq.replay",           category: "dlq",       description: "Replay a dead-lettered run/node",          defaultRoles: ["editor", "admin"] },
  // recovery
  { key: "recovery.read",        category: "recovery",  description: "View recovery metrics + delta",            defaultRoles: ["viewer", "editor", "admin"] },
  { key: "recovery.write",       category: "recovery",  description: "Submit recovery feedback, manage recovery items (acknowledge / resolve / comment / escalate)", defaultRoles: ["editor", "admin"] },
  // reports
  { key: "reports.read",         category: "reports",   description: "Download run-explain reports",             defaultRoles: ["viewer", "editor", "admin"] },
  { key: "reports.deliver",      category: "reports",   description: "Deliver run-explain via Slack / GitHub / webhook", defaultRoles: ["editor", "admin"] },
  // ai
  { key: "ai.write",             category: "ai",        description: "Use AI generate / patch / suggest / explain", defaultRoles: ["editor", "admin"] },
  // members
  { key: "members.read",         category: "members",   description: "View members + invitations",               defaultRoles: ["viewer", "editor", "admin"] },
  { key: "members.write",        category: "members",   description: "Invite, remove, and change member roles",  defaultRoles: ["admin"] },
  { key: "members.role_set",     category: "members",   description: "Change a member's role specifically",      defaultRoles: ["admin"] },
  // org config / security
  { key: "org.config.write",     category: "org",       description: "Edit org-level configuration (budget, auth policies, …)", defaultRoles: ["admin"] },
  { key: "org.permissions.write",category: "org",       description: "Manage permission catalog overrides + custom roles", defaultRoles: ["admin"] },
  // mcp client connections
  { key: "mcp.connections.read", category: "mcp",       description: "View external MCP server connections + cached tool descriptors", defaultRoles: ["viewer", "editor", "admin"] },
  { key: "mcp.connections.write",category: "mcp",       description: "Register / edit / delete external MCP server connections + enable per-tool descriptors", defaultRoles: ["admin"] },
  // supervised auto-healing decisions
  { key: "autohealing.read",     category: "auto-healing", description: "View pending supervised auto-healing decisions",                                  defaultRoles: ["viewer", "editor", "admin"] },
  { key: "autohealing.decide",   category: "auto-healing", description: "Apply or decline a pending auto-healing decision; trigger ad-hoc scans (admin only)", defaultRoles: ["editor", "admin"] },
  // promptops registry
  { key: "prompts.read",         category: "prompts",   description: "View prompts + versions in the PromptOps registry", defaultRoles: ["viewer", "editor", "admin"] },
  { key: "prompts.write",        category: "prompts",   description: "Create prompts, append new versions, pin active version", defaultRoles: ["editor", "admin"] },
  // credentials health + admin CRUD
  { key: "credentials.read",     category: "credentials", description: "View credentials + credential / MCP connection health", defaultRoles: ["viewer", "editor", "admin"] },
  { key: "credentials.write",    category: "credentials", description: "Register / edit / delete credentials",                  defaultRoles: ["admin"] },
  // recovery alerting policies
  { key: "alerts.read",          category: "alerts",      description: "View alert policies and recently fired alerts",         defaultRoles: ["viewer", "editor", "admin"] },
  { key: "alerts.write",         category: "alerts",      description: "Create / edit / delete recovery alerting policies",     defaultRoles: ["admin"] },
  // upstream health sources
  { key: "upstream.read",        category: "upstream",    description: "View upstream health sources + derived status",         defaultRoles: ["viewer", "editor", "admin"] },
  { key: "upstream.write",       category: "upstream",    description: "Register / edit / delete upstream health sources",      defaultRoles: ["admin"] },
  // workflow snippets library
  { key: "snippets.read",        category: "snippets",    description: "View built-in + org-private workflow snippets",         defaultRoles: ["viewer", "editor", "admin"] },
  { key: "snippets.write",       category: "snippets",    description: "Create / edit / delete org-private workflow snippets",  defaultRoles: ["admin"] },
  // eval datasets (built from opted-in accepted recovery feedback)
  { key: "evals.read",           category: "evals",       description: "View + export eval datasets built from recovery decisions", defaultRoles: ["viewer", "editor", "admin"] },
  { key: "evals.write",          category: "evals",       description: "Create / delete eval datasets from opted-in recovery feedback", defaultRoles: ["admin"] },
  // inbound trigger events (email_received / file_dropped / mcp_server_event)
  { key: "triggers.read",        category: "triggers",    description: "View structured inbound-trigger events + replay history", defaultRoles: ["viewer", "editor", "admin"] },
  { key: "triggers.ingest",      category: "triggers",    description: "Submit a normalized inbound trigger event (relay / forwarder)", defaultRoles: ["editor", "admin"] },
  // solution packs (installable, ICP-shaped workflow starters)
  { key: "packs.read",           category: "packs",       description: "View the solution-pack catalog + per-org dependency hints", defaultRoles: ["viewer", "editor", "admin"] },
  { key: "packs.install",        category: "packs",       description: "Install a pack as a draft workflow, run a sandbox sample, or inject a demo failure", defaultRoles: ["editor", "admin"] },
  // onboarding ("first recovered run" guided checklist — per-user self-service)
  { key: "onboarding.read",      category: "onboarding",  description: "View own onboarding checklist progress",                    defaultRoles: ["viewer", "editor", "admin"] },
  { key: "onboarding.write",     category: "onboarding",  description: "Skip or resume own onboarding checklist",                   defaultRoles: ["viewer", "editor", "admin"] },
] as const satisfies readonly PermissionEntry[];

export type Permission = (typeof PERMISSION_CATALOG)[number]["key"];

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map((e) => e.key));

/**
 * Type guard for runtime validation of permission-key strings (e.g.
 * incoming admin requests, override JSONB blobs).
 */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_KEY_SET.has(value);
}

/**
 * Default permission set per built-in role, derived once at module
 * load from `PERMISSION_CATALOG`. The `ReadonlySet<Permission>` cast is
 * the type-level guarantee against mutation — `Object.freeze` only
 * freezes the wrapper object, not the inner `Set` instances. Don't
 * call `.add()` / `.delete()` / `.clear()` on these from consumers;
 * overrides construct new sets via `getEffectivePermissions`.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = (() => {
  const map: Record<Role, Set<Permission>> = { viewer: new Set(), editor: new Set(), admin: new Set() };
  for (const entry of PERMISSION_CATALOG) {
    for (const role of entry.defaultRoles) map[role].add(entry.key as Permission);
  }
  return Object.freeze({
    viewer: map.viewer as ReadonlySet<Permission>,
    editor: map.editor as ReadonlySet<Permission>,
    admin: map.admin as ReadonlySet<Permission>,
  });
})();

/**
 * Permissions that the built-in `admin` role MUST always grant. The
 * server forcibly re-includes these when an admin tries to save an
 * override that excludes them — otherwise the admin would lock
 * themselves out of the role-management surface itself.
 *
 * Custom roles with `inheritsFrom: "admin"` are NOT subject to this
 * floor; an operator can create a narrower admin-rank role (e.g.
 * `billing-admin` with only `org.config.write`) as long as the
 * built-in `admin` role itself remains capable.
 */
export function mandatoryAdminPermissions(): readonly Permission[] {
  return ["org.permissions.write", "members.write"];
}

/**
 * Validate every key in an array against the catalog. Used by the
 * roles repo at write time so a malformed override JSONB cannot land
 * in the DB.
 */
export function assertPermissionsValid(permissions: readonly unknown[]): asserts permissions is readonly Permission[] {
  for (const p of permissions) {
    if (!isPermission(p)) {
      throw new Error(`unknown permission key: ${String(p)}`);
    }
  }
}
