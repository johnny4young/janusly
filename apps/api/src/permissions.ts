import { db, orgMembers } from '@workflow-engine/db'
import { and, eq } from 'drizzle-orm'

export type Role = 'viewer' | 'editor' | 'admin'

const rank: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
}

export async function getMemberRole(orgId: string, userId: string): Promise<Role> {
  const rows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))

  return (rows[0]?.role as Role | undefined) ?? 'admin'
}

export async function requireRole(orgId: string, userId: string, required: Role) {
  const role = await getMemberRole(orgId, userId)

  if (rank[role] < rank[required]) {
    const err = new Error(`Forbidden: requires ${required} role`)
    ;(err as any).statusCode = 403
    throw err
  }

  return role
}
