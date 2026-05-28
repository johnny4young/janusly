/**
 * Role + permission gates for `apps/api/src/server.ts`.
 *
 * Two layers of authorization, both keyed on `org_members.role`:
 *
 *   1. **Rank-based** — the historical model. `requireRole(min)` reads
 *      the user's role and rejects when their rank is below `min`
 *      (`viewer < editor < admin`). Custom roles map to a built-in
 *      rank via `org_roles.inheritsFrom`. Back-compat for the 37
 *      routes that haven't been migrated to permission gates yet.
 *
 *   2. **Permission-based** — the new model.
 *      `requirePermission(perm)` reads the user's role NAME (built-in
 *      or custom), resolves their effective permission set against
 *      the catalog defaults plus any `org_roles.grantedPermissions`
 *      override, and rejects when `perm` is absent from the set.
 *
 * Adding a new permission is a one-line edit to
 * `permission-catalog.ts`; per-org overrides land in `org_roles` via
 * the admin CRUD in `routes/roles-routes.ts`.
 *
 * Dev-headers fallback: when no `org_members` row exists AND mode is
 * `dev-headers`, the caller is treated as `admin` so local development
 * works without seeding. Production (Supabase / service-token / SSO)
 * never auto-grants admin.
 *
 * Invariants:
 * - Roles are ordinal (`viewer < editor < admin`); rank-check passes
 *   when the user's rank is ≥ the required rank.
 * - Service-token mode does NOT auto-grant admin — the caller must
 *   have an explicit `org_members` row.
 * - Permission checks consult ONLY the effective permission set —
 *   they never compare ranks. Two routes can declare both `role:`
 *   AND `permission:` for defense in depth; both must pass.
 */

import { db, orgMembers } from '@janusly/db'
import { and, eq } from 'drizzle-orm'
import { getOrgRole } from '@janusly/data'

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  isPermission,
} from './permission-catalog'

/** Closed enum of org-level built-in roles. Custom roles inherit a built-in's RANK via `org_roles.inheritsFrom`. */
export type Role = 'viewer' | 'editor' | 'admin'
/** Auth mode forwarded from `auth.ts` so dev-headers can fall back to admin. */
export type AuthMode = 'supabase' | 'dev-headers' | 'service-token' | 'janusly-session'

const rank: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
}

/** Type guard for the built-in `Role` enum. Does NOT accept custom role names. */
export function isRole(value: unknown): value is Role {
  return value === 'viewer' || value === 'editor' || value === 'admin'
}

/**
 * The user's role NAME plus the built-in it inherits its rank from.
 * For built-ins the name equals `inheritsFrom`. For custom roles
 * (`compliance`, `ops-readonly`, ...) the name is the org-defined
 * label and `inheritsFrom` is the rank-equivalent built-in.
 */
export type ResolvedMemberRole = { name: string; inheritsFrom: Role }

/**
 * Resolve a user's role in an org, returning both the literal name
 * (for permission-set lookup) and the inherited built-in (for rank
 * comparison). Custom-role-aware: consults `org_roles` when the
 * literal name isn't one of the 3 built-ins.
 */
export async function resolveMemberRole(orgId: string, userId: string, mode: AuthMode = 'supabase'): Promise<ResolvedMemberRole | null> {
  const rows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))

  const literal = rows[0]?.role
  if (typeof literal === 'string' && literal.length > 0) {
    if (isRole(literal)) return { name: literal, inheritsFrom: literal }
    // Custom role: look up its rank inheritance.
    const orgRole = await getOrgRole({ orgId, name: literal })
    if (orgRole && isRole(orgRole.inheritsFrom)) {
      return { name: orgRole.name, inheritsFrom: orgRole.inheritsFrom }
    }
    // Unknown custom role name on the membership but no `org_roles`
    // row defining it — defensively reject. This shouldn't happen
    // in steady state because the role CRUD validates names, but
    // it could after a role is deleted while a member still
    // references it. Treat as no membership.
    return null
  }

  // No `org_members` row found.
  return mode === 'dev-headers' ? { name: 'admin', inheritsFrom: 'admin' } : null
}

/**
 * Back-compat helper for callers that want just the rank-equivalent
 * built-in name (the shape `requireRole` and the existing 37 routes
 * reason about).
 */
export async function getMemberRole(orgId: string, userId: string, mode: AuthMode = 'supabase'): Promise<Role | null> {
  const resolved = await resolveMemberRole(orgId, userId, mode)
  return resolved?.inheritsFrom ?? null
}

/** `getMemberRole` + throw 403 when below `required`. The standard route gate. */
export async function requireRole(orgId: string, userId: string, required: Role, mode: AuthMode = 'supabase') {
  const role = await getMemberRole(orgId, userId, mode)

  if (!role || rank[role] < rank[required]) {
    const err = new Error(`Forbidden: requires ${required} role`) as Error & { statusCode?: number }
    err.statusCode = 403
    throw err
  }

  return role
}

/**
 * Resolve the effective permission set for a given org + role name.
 *
 * Lookup:
 *  1. `org_roles` has a row with non-null `grantedPermissions`: use it
 *     verbatim. Override REPLACES the default set; it's not additive.
 *  2. No row (or row with null permissions): if the name is a
 *     built-in, fall back to `DEFAULT_ROLE_PERMISSIONS[builtin]`.
 *     Custom roles always have a row, so a null-permissions custom
 *     role is a data-integrity bug and returns the empty set
 *     (fail-closed).
 *
 * Returns a `ReadonlySet<Permission>` so callers can't mutate the
 * shared default sets.
 */
export async function getEffectivePermissions(orgId: string, roleName: string): Promise<ReadonlySet<Permission>> {
  const row = await getOrgRole({ orgId, name: roleName })
  if (row && row.grantedPermissions !== null) {
    const filtered = new Set<Permission>()
    for (const p of row.grantedPermissions) {
      if (isPermission(p)) filtered.add(p)
    }
    return filtered
  }
  if (isRole(roleName)) {
    return DEFAULT_ROLE_PERMISSIONS[roleName]
  }
  // Custom role with no `grantedPermissions` is a corrupt state;
  // fail-closed by returning the empty set.
  return new Set<Permission>()
}

/**
 * Throw 403 when the caller's effective permission set doesn't
 * include `perm`. Used by route handlers that declare a
 * `permission:` field on the route registry entry.
 *
 * Dev-headers fallback: when no `org_members` row exists, treat as
 * built-in `admin` and consult its effective set (admin keeps the
 * mandatory-permissions floor — see `permission-catalog.ts`).
 */
export async function requirePermission(orgId: string, userId: string, perm: Permission, mode: AuthMode = 'supabase') {
  const resolved = await resolveMemberRole(orgId, userId, mode)
  if (!resolved) {
    const err = new Error(`Forbidden: requires permission ${perm}`) as Error & { statusCode?: number }
    err.statusCode = 403
    throw err
  }
  const effective = await getEffectivePermissions(orgId, resolved.name)
  if (!effective.has(perm)) {
    const err = new Error(`Forbidden: requires permission ${perm}`) as Error & { statusCode?: number }
    err.statusCode = 403
    throw err
  }
  return resolved
}
