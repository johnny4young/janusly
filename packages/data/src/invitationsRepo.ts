/**
 * Pending email-based invitations to an organization.
 *
 * Multi-tenant scope: every read and write carries
 * `eq(invitations.orgId, orgId)`. Unique `(orgId, email)` means the same
 * recipient has one durable invitation row; re-issuing an accepted / revoked
 * invite flips that row back to `pending` instead of creating duplicates.
 *
 * The membership resolver in `apps/api/src/auth.ts` calls
 * `findPendingInvitation` on every Supabase sign-in. When a row matches the
 * authenticated user's email + the target org, the resolver flips status to
 * `accepted` via `acceptInvitation` and then upserts the `org_members` row.
 *
 * Used by:
 * - `apps/api/src/auth.ts` (resolver auto-acceptance path).
 * - `apps/api/src/routes/members-routes.ts` (admin invite/list/revoke).
 */

import { and, eq } from "drizzle-orm";
import { db, invitations } from "@janusly/db";

export type InvitationStatus = "pending" | "accepted" | "revoked";

export type InvitationRow = {
  id: string;
  orgId: string;
  email: string;
  role: string;
  invitedBy: string | null;
  status: InvitationStatus;
  acceptedAt: Date | string | null;
  createdAt: Date | string | null;
};

function mapRow(row: typeof invitations.$inferSelect): InvitationRow {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    status: row.status as InvitationStatus,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
  };
}

/** Find the still-`pending` invitation row for `(orgId, email)`, or `null`. */
export async function findPendingInvitation(
  input: { orgId: string; email: string },
): Promise<InvitationRow | null> {
  const email = input.email.trim().toLowerCase();
  if (!email) return null;
  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.orgId, input.orgId), eq(invitations.email, email)));
  const row = rows[0];
  if (!row || row.status !== "pending") return null;
  return mapRow(row);
}

/** Insert a new pending invitation, or re-open an accepted / revoked row for the same email. */
export async function createInvitation(
  input: { orgId: string; email: string; role: string; invitedBy: string | null },
): Promise<InvitationRow> {
  const id = crypto.randomUUID();
  const email = input.email.trim().toLowerCase();
  const [row] = await db
    .insert(invitations)
    .values({
      id,
      orgId: input.orgId,
      email,
      role: input.role,
      invitedBy: input.invitedBy,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [invitations.orgId, invitations.email],
      set: {
        role: input.role,
        invitedBy: input.invitedBy,
        status: "pending",
        acceptedAt: null,
      },
    })
    .returning();
  if (!row) throw new Error("invitation vanished after upsert");
  return mapRow(row);
}

/**
 * Flip status `pending → accepted` and stamp `acceptedAt`. Idempotent: if
 * the row is already accepted (e.g. concurrent sign-ins), this is a no-op.
 * Multi-tenant scope: caller's `orgId` is enforced via the column predicate.
 */
export async function acceptInvitation(
  input: { id: string; orgId: string },
): Promise<boolean> {
  const rows = await db
    .update(invitations)
    .set({ status: "accepted", acceptedAt: new Date() })
    .where(
      and(
        eq(invitations.id, input.id),
        eq(invitations.orgId, input.orgId),
        eq(invitations.status, "pending"),
      ),
    )
    .returning({ id: invitations.id });
  return rows.length > 0;
}

/** Flip status `pending → revoked`. Audited at the route layer. */
export async function revokeInvitation(
  input: { id: string; orgId: string },
): Promise<boolean> {
  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, input.id), eq(invitations.orgId, input.orgId)));
  const row = rows[0];
  if (!row || row.status !== "pending") return false;
  await db
    .update(invitations)
    .set({ status: "revoked" })
    .where(and(eq(invitations.id, input.id), eq(invitations.orgId, input.orgId)));
  return true;
}

/** List every invitation for the org regardless of status (admin view). */
export async function listInvitationsByOrg(orgId: string): Promise<InvitationRow[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.orgId, orgId));
  return rows.map(mapRow);
}
