/**
 * Role gate for `apps/api/src/server.ts`. Reads `org_members` and rejects
 * 403 when the caller's role is below the required level. The dev-headers
 * mode falls back to `admin` only when no `org_members` row exists, so
 * local development just works without seeding; production (Supabase /
 * service-token) never auto-grants admin.
 *
 * Used by the central route dispatcher in `apps/api/src/server.ts`
 * (`requireRole(auth.orgId, auth.userId, 'editor', auth.mode)` style).
 *
 * Invariants:
 * - Roles are ordinal (`viewer < editor < admin`); a caller satisfies a
 *   `required` level when their rank is ≥ `rank[required]`.
 * - Service-token mode does NOT auto-grant admin — the calling system
 *   must have an explicit `org_members` row.
 */

import { db, orgMembers } from '@janusly/db'
import { and, eq } from 'drizzle-orm'

/** Closed enum of org-level roles. */
export type Role = 'viewer' | 'editor' | 'admin'
/** Auth mode forwarded from `auth.ts` so dev-headers can fall back to admin. */
export type AuthMode = 'supabase' | 'dev-headers' | 'service-token' | 'janusly-session'

const rank: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
}

/** Type guard for the `Role` enum. */
export function isRole(value: unknown): value is Role {
  return value === 'viewer' || value === 'editor' || value === 'admin'
}

/** Resolve a user's role in an org, with the dev-headers default-admin fallback. */
export async function getMemberRole(orgId: string, userId: string, mode: AuthMode = 'supabase'): Promise<Role | null> {
  const rows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))

  const role = rows[0]?.role
  if (isRole(role)) return role

  return mode === 'dev-headers' ? 'admin' : null
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
