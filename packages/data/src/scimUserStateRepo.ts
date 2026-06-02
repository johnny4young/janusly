/**
 * Per-(directory, IdP-side user) state for SCIM lifecycle ops. The
 * `providerUserId` is the WorkOS `directory_user.id` (stable across
 * email changes); `email` carries the user's current address and is
 * the join key into `org_members`. `active=false` marks a user the
 * IdP has deprovisioned — the resurrection guard refuses to re-create
 * membership for a deactivated row with an older event timestamp.
 *
 * Multi-tenant scope: every read carries
 * `eq(scimUserState.scimDirectoryId, …)` which is per-org by design
 * (each directory belongs to one org).
 *
 * Used by:
 * - `apps/api/src/scim-event-handler.ts` (every event handler).
 */

import { and, eq } from "drizzle-orm";
import { db, scimUserState } from "@janusly/db";

export type ScimUserStateRow = {
  id: string;
  orgId: string;
  scimDirectoryId: string;
  providerUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  active: boolean;
  lastEventId: string | null;
  lastEventTimestamp: Date | string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

function mapRow(row: typeof scimUserState.$inferSelect): ScimUserStateRow {
  return {
    id: row.id,
    orgId: row.orgId,
    scimDirectoryId: row.scimDirectoryId,
    providerUserId: row.providerUserId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    active: row.active,
    lastEventId: row.lastEventId,
    lastEventTimestamp: row.lastEventTimestamp,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Read state for a specific (directory, provider_user_id). */
export async function getScimUserState(
  input: { scimDirectoryId: string; providerUserId: string },
): Promise<ScimUserStateRow | null> {
  const rows = await db
    .select()
    .from(scimUserState)
    .where(
      and(
        eq(scimUserState.scimDirectoryId, input.scimDirectoryId),
        eq(scimUserState.providerUserId, input.providerUserId),
      ),
    );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Upsert by `(scimDirectoryId, providerUserId)` — INSERT or UPDATE
 * depending on whether the row exists. `eventTimestamp` and `eventId`
 * record the event that produced this state so the out-of-order guard
 * can compare against subsequent events.
 */
export async function upsertScimUserState(input: {
  orgId: string;
  scimDirectoryId: string;
  providerUserId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  active: boolean;
  lastEventId: string;
  lastEventTimestamp: Date;
}): Promise<ScimUserStateRow> {
  const existing = await getScimUserState({
    scimDirectoryId: input.scimDirectoryId,
    providerUserId: input.providerUserId,
  });
  if (existing) {
    await db
      .update(scimUserState)
      .set({
        email: input.email,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        active: input.active,
        lastEventId: input.lastEventId,
        lastEventTimestamp: input.lastEventTimestamp,
        updatedAt: new Date(),
      })
      .where(eq(scimUserState.id, existing.id));
    const refreshed = await getScimUserState({
      scimDirectoryId: input.scimDirectoryId,
      providerUserId: input.providerUserId,
    });
    if (!refreshed) throw new Error("scim_user_state row vanished after update");
    return refreshed;
  }
  const id = crypto.randomUUID();
  await db.insert(scimUserState).values({
    id,
    orgId: input.orgId,
    scimDirectoryId: input.scimDirectoryId,
    providerUserId: input.providerUserId,
    email: input.email,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    active: input.active,
    lastEventId: input.lastEventId,
    lastEventTimestamp: input.lastEventTimestamp,
  });
  const created = await getScimUserState({
    scimDirectoryId: input.scimDirectoryId,
    providerUserId: input.providerUserId,
  });
  if (!created) throw new Error("scim_user_state row vanished after insert");
  return created;
}

/** Mark a user inactive (deprovisioned). Does NOT touch `org_members`. */
export async function markScimUserInactive(input: {
  id: string;
  eventId: string;
  eventTimestamp: Date;
}): Promise<void> {
  await db
    .update(scimUserState)
    .set({
      active: false,
      lastEventId: input.eventId,
      lastEventTimestamp: input.eventTimestamp,
      updatedAt: new Date(),
    })
    .where(eq(scimUserState.id, input.id));
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
