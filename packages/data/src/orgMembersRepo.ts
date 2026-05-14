/**
 * Accepted org membership rows — the canonical authority for "this user
 * belongs to this org with this role". The membership resolver in
 * `apps/api/src/auth.ts` reads this table on every Supabase sign-in
 * (priority 1, before invitations / verified domains / SSO).
 *
 * Multi-tenant scope: every read and write carries
 * `eq(orgMembers.orgId, orgId)`. The unique `(orgId, userId)` constraint
 * makes upserts straightforward.
 *
 * Legacy-orphan handling: pre-existing rows where `userId` is an email
 * string (placeholder before invite-acceptance shipped) are detected via
 * `findMemberByEmail`; the resolver rewrites the `userId` to the real
 * Supabase UUID on first sign-in.
 *
 * Used by:
 * - `apps/api/src/auth.ts` (resolver direct match + legacy backfill).
 * - `apps/api/src/permissions.ts` (`getMemberRole`).
 * - `apps/api/src/routes/members-routes.ts` (admin CRUD).
 */

import { and, eq } from "drizzle-orm";
import { db, orgMembers } from "@janusly/db";

export type OrgMemberRow = {
  id: string;
  orgId: string;
  userId: string;
  email: string | null;
  role: string;
  invitedBy: string | null;
  createdAt: Date | string | null;
};

function mapRow(row: typeof orgMembers.$inferSelect): OrgMemberRow {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
  };
}

/** Find the org_members row for `(orgId, userId)`, or `null`. */
export async function getMembershipForOrgUser(
  input: { orgId: string; userId: string },
): Promise<OrgMemberRow | null> {
  const rows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.userId)));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** List every accepted membership for a user across orgs (used when the request has no `x-org-id` hint). */
export async function listMembershipsForUser(userId: string): Promise<OrgMemberRow[]> {
  const rows = await db
    .select()
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId));
  return rows.map(mapRow);
}

/**
 * Find an existing row for `(orgId, email)` — used to detect legacy
 * `userId = email` placeholder rows so the resolver can lazy-backfill the
 * real Supabase UUID.
 */
export async function findMemberByEmail(
  input: { orgId: string; email: string },
): Promise<OrgMemberRow | null> {
  const email = input.email.trim().toLowerCase();
  if (!email) return null;
  const rows = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.email, email)));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Atomically insert-or-update the row keyed by `(orgId, userId)`. Used by
 * the resolver after invitation acceptance / verified-domain auto-join.
 * Returns the resulting row.
 */
export async function upsertMembership(
  input: {
    orgId: string;
    userId: string;
    email: string | null;
    role: string;
    invitedBy?: string | null;
  },
): Promise<OrgMemberRow> {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(orgMembers)
    .values({
      id,
      orgId: input.orgId,
      userId: input.userId,
      email: input.email,
      role: input.role,
      invitedBy: input.invitedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [orgMembers.orgId, orgMembers.userId],
      set: {
        email: input.email,
        role: input.role,
        invitedBy: input.invitedBy ?? null,
      },
    })
    .returning();
  if (!row) throw new Error("org_members row vanished after upsert");
  return mapRow(row);
}

/**
 * Rewrite the `userId` of an existing row (legacy `userId = email`
 * placeholders → real Supabase UUID). The resolver calls this exactly once
 * per legacy row, on the user's first authenticated sign-in.
 */
export async function migrateMemberUserId(
  input: { id: string; orgId: string; newUserId: string },
): Promise<void> {
  await db
    .update(orgMembers)
    .set({ userId: input.newUserId })
    .where(and(eq(orgMembers.id, input.id), eq(orgMembers.orgId, input.orgId)));
}
