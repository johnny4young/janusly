/**
 * Provider-neutral identity profile and organization bootstrap writes.
 *
 * `users` is a global profile keyed by the provider-stable identity id;
 * tenant authority remains exclusively in `org_members`. Organization
 * creation and invitation acceptance use transaction-bound audit writes so a
 * grant can never exist without its forensic event (or vice versa).
 *
 * Used by:
 * - `apps/api/src/routes/auth-context-routes.ts`.
 */

import { and, eq } from "drizzle-orm";
import { db, invitations, organizations, orgMembers, users } from "@janusly/db";

import { withAuditTx } from "./audit-tx";

export type UserProfileRow = {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

export type CreatedOrganization = {
  id: string;
  name: string;
  plan: string;
  role: "admin";
};

function mapProfile(row: typeof users.$inferSelect): UserProfileRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Read one global identity profile, or null when it has not been created. */
export async function getUserProfile(userId: string): Promise<UserProfileRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId));
  return rows[0] ? mapProfile(rows[0]) : null;
}

/**
 * Create an organization, its founder membership, global profile, and audit
 * event in one transaction.
 */
export async function createOrganizationForIdentity(input: {
  userId: string;
  email: string | null;
  profileName: string | null;
  organizationName: string;
}): Promise<{ ok: true; result: CreatedOrganization } | { ok: false; error: string }> {
  const organizationId = `org_${crypto.randomUUID()}`;
  const memberId = crypto.randomUUID();
  const now = new Date();

  return withAuditTx(async (tx, audit) => {
    await tx.insert(users).values({
      id: input.userId,
      email: input.email,
      name: input.profileName,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: users.id,
      set: {
        ...(input.email ? { email: input.email } : {}),
        ...(input.profileName ? { name: input.profileName } : {}),
        updatedAt: now,
      },
    });
    await tx.insert(organizations).values({
      id: organizationId,
      name: input.organizationName,
      plan: "free",
    });
    await tx.insert(orgMembers).values({
      id: memberId,
      orgId: organizationId,
      userId: input.userId,
      email: input.email,
      role: "admin",
      invitedBy: null,
    });
    await audit({
      orgId: organizationId,
      userId: input.userId,
      action: "org.created",
      targetType: "organization",
      targetId: organizationId,
      metadata: { name: input.organizationName, plan: "free", founderRole: "admin" },
    });
    return { id: organizationId, name: input.organizationName, plan: "free", role: "admin" };
  });
}

/** Update the caller's global profile and audit in the selected tenant. */
export async function updateUserProfile(input: {
  userId: string;
  orgId: string;
  email: string | null;
  name: string | null;
}): Promise<{ ok: true; result: UserProfileRow } | { ok: false; error: string }> {
  const now = new Date();
  return withAuditTx(async (tx, audit) => {
    const [row] = await tx.insert(users).values({
      id: input.userId,
      email: input.email,
      name: input.name,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: users.id,
      set: {
        ...(input.email ? { email: input.email } : {}),
        name: input.name,
        updatedAt: now,
      },
    }).returning();
    if (!row) throw new Error("profile vanished after upsert");
    await audit({
      orgId: input.orgId,
      userId: input.userId,
      action: "user.profile.updated",
      targetType: "user",
      targetId: input.userId,
      metadata: { nameChanged: true },
    });
    return mapProfile(row);
  });
}

/**
 * Accept exactly one pending invitation for the verified email. The invitation
 * state, membership grant, profile, and audit row commit or roll back together.
 */
export async function acceptInvitationForIdentity(input: {
  invitationId: string;
  userId: string;
  email: string;
  profileName?: string | null;
  expectedOrgId?: string;
}): Promise<
  | { ok: true; result: { orgId: string; role: string } }
  | { ok: false; error: string }
> {
  const email = input.email.trim().toLowerCase();
  return withAuditTx(async (tx, audit) => {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(and(
        eq(invitations.id, input.invitationId),
        eq(invitations.email, email),
        eq(invitations.status, "pending"),
        input.expectedOrgId ? eq(invitations.orgId, input.expectedOrgId) : undefined,
      ))
      .for("update");
    if (!invitation) throw new Error("invitation_not_found");

    const now = new Date();
    await tx.update(invitations)
      .set({ status: "accepted", acceptedAt: now })
      .where(and(eq(invitations.id, invitation.id), eq(invitations.status, "pending")));
    await tx.insert(users).values({
      id: input.userId,
      email,
      name: input.profileName ?? null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: users.id,
      set: {
        email,
        ...(input.profileName ? { name: input.profileName } : {}),
        updatedAt: now,
      },
    });
    await tx.insert(orgMembers).values({
      id: crypto.randomUUID(),
      orgId: invitation.orgId,
      userId: input.userId,
      email,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
    }).onConflictDoUpdate({
      target: [orgMembers.orgId, orgMembers.userId],
      set: { email, role: invitation.role, invitedBy: invitation.invitedBy },
    });
    await audit({
      orgId: invitation.orgId,
      userId: input.userId,
      action: "member.joined",
      targetType: "member",
      targetId: input.userId,
      metadata: { via: "invitation", invitationId: invitation.id, role: invitation.role },
    });
    return { orgId: invitation.orgId, role: invitation.role };
  });
}
