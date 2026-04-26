import { db, orgMembers } from '@workflow-engine/db'
import { and, eq } from 'drizzle-orm'

export type Role = 'viewer' | 'editor' | 'admin'
export type AuthMode = 'supabase' | 'dev-headers' | 'service-token'

const rank: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
}

export function isRole(value: unknown): value is Role {
  return value === 'viewer' || value === 'editor' || value === 'admin'
}

export async function getMemberRole(orgId: string, userId: string, mode: AuthMode = 'supabase'): Promise<Role | null> {
  const rows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))

  const role = rows[0]?.role
  if (isRole(role)) return role

  return mode === 'dev-headers' || mode === 'service-token' ? 'admin' : null
}

export async function requireRole(orgId: string, userId: string, required: Role, mode: AuthMode = 'supabase') {
  const role = await getMemberRole(orgId, userId, mode)

  if (!role || rank[role] < rank[required]) {
    const err = new Error(`Forbidden: requires ${required} role`) as Error & { statusCode?: number }
    err.statusCode = 403
    throw err
  }

  return role
}
