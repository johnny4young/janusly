/**
 * User↔group membership mirror for SCIM v2 role derivation, maintained by
 * the `dsync.group.user_added` / `_removed` events. Keyed by the WorkOS
 * `directory_user.id` (providerUserId) + `directory_group.id`
 * (providerGroupId) within a directory. Every query is still explicitly
 * org-scoped: the directory row is resolved org-side before the handler runs,
 * but the table carries `orgId` as a defense-in-depth tenant guard.
 *
 * Orphan-tolerant: no FK. `addScimUserGroup` is idempotent (ON CONFLICT
 * DO NOTHING on the `(directory, user, group)` unique index), so a
 * replayed membership event is a no-op.
 *
 * Used by:
 * - `apps/api/src/scim-event-handler.ts` (membership events + derivation).
 */

import { and, eq } from "drizzle-orm";
import { db, scimUserGroups } from "@janusly/db";

/** Record that a directory user belongs to a group. Idempotent. */
export async function addScimUserGroup(input: {
  orgId: string;
  scimDirectoryId: string;
  providerUserId: string;
  providerGroupId: string;
}): Promise<void> {
  await db
    .insert(scimUserGroups)
    .values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      scimDirectoryId: input.scimDirectoryId,
      providerUserId: input.providerUserId,
      providerGroupId: input.providerGroupId,
    })
    .onConflictDoNothing();
}

/** Remove a single user↔group membership. No-op when the row is absent. */
export async function removeScimUserGroup(input: {
  orgId: string;
  scimDirectoryId: string;
  providerUserId: string;
  providerGroupId: string;
}): Promise<void> {
  await db
    .delete(scimUserGroups)
    .where(
      and(
        eq(scimUserGroups.orgId, input.orgId),
        eq(scimUserGroups.scimDirectoryId, input.scimDirectoryId),
        eq(scimUserGroups.providerUserId, input.providerUserId),
        eq(scimUserGroups.providerGroupId, input.providerGroupId),
      ),
    );
}

/** The providerGroupIds a directory user currently belongs to. */
export async function listScimUserGroupIds(input: {
  orgId: string;
  scimDirectoryId: string;
  providerUserId: string;
}): Promise<string[]> {
  const rows = await db
    .select({ providerGroupId: scimUserGroups.providerGroupId })
    .from(scimUserGroups)
    .where(
      and(
        eq(scimUserGroups.orgId, input.orgId),
        eq(scimUserGroups.scimDirectoryId, input.scimDirectoryId),
        eq(scimUserGroups.providerUserId, input.providerUserId),
      ),
    );
  return rows.map((row) => row.providerGroupId);
}

/** The providerUserIds currently associated with a directory group. */
export async function listScimUserIdsForGroup(input: {
  orgId: string;
  scimDirectoryId: string;
  providerGroupId: string;
}): Promise<string[]> {
  const rows = await db
    .select({ providerUserId: scimUserGroups.providerUserId })
    .from(scimUserGroups)
    .where(
      and(
        eq(scimUserGroups.orgId, input.orgId),
        eq(scimUserGroups.scimDirectoryId, input.scimDirectoryId),
        eq(scimUserGroups.providerGroupId, input.providerGroupId),
      ),
    );
  return rows.map((row) => row.providerUserId);
}

/** Cleanup hook: drop every membership row for a deleted user. */
export async function deleteScimUserGroupsForUser(input: {
  orgId: string;
  scimDirectoryId: string;
  providerUserId: string;
}): Promise<void> {
  await db
    .delete(scimUserGroups)
    .where(
      and(
        eq(scimUserGroups.orgId, input.orgId),
        eq(scimUserGroups.scimDirectoryId, input.scimDirectoryId),
        eq(scimUserGroups.providerUserId, input.providerUserId),
      ),
    );
}

/** Cleanup hook: drop every membership row for a deleted group. */
export async function deleteScimUserGroupsForGroup(input: {
  orgId: string;
  scimDirectoryId: string;
  providerGroupId: string;
}): Promise<void> {
  await db
    .delete(scimUserGroups)
    .where(
      and(
        eq(scimUserGroups.orgId, input.orgId),
        eq(scimUserGroups.scimDirectoryId, input.scimDirectoryId),
        eq(scimUserGroups.providerGroupId, input.providerGroupId),
      ),
    );
}
