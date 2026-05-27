/**
 * Per-(directory, IdP-side group) state. v1 captures group existence
 * + name so the data is available for future role-mapping; v2 will
 * add an explicit `scim_group_role_mappings` table for operator-
 * configured role overrides per group.
 *
 * Used by:
 * - `apps/api/src/scim-event-handler.ts` (group event handlers).
 */

import { and, eq } from "drizzle-orm";
import { db, scimGroupState } from "@janusly/db";

export type ScimGroupStateRow = {
  id: string;
  orgId: string;
  scimDirectoryId: string;
  providerGroupId: string;
  name: string;
  lastSyncedAt: Date | string | null;
};

function mapRow(row: typeof scimGroupState.$inferSelect): ScimGroupStateRow {
  return {
    id: row.id,
    orgId: row.orgId,
    scimDirectoryId: row.scimDirectoryId,
    providerGroupId: row.providerGroupId,
    name: row.name,
    lastSyncedAt: row.lastSyncedAt,
  };
}

export async function getScimGroupState(
  input: { scimDirectoryId: string; providerGroupId: string },
): Promise<ScimGroupStateRow | null> {
  const rows = await db
    .select()
    .from(scimGroupState)
    .where(
      and(
        eq(scimGroupState.scimDirectoryId, input.scimDirectoryId),
        eq(scimGroupState.providerGroupId, input.providerGroupId),
      ),
    );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function upsertScimGroupState(input: {
  orgId: string;
  scimDirectoryId: string;
  providerGroupId: string;
  name: string;
}): Promise<ScimGroupStateRow> {
  const existing = await getScimGroupState({
    scimDirectoryId: input.scimDirectoryId,
    providerGroupId: input.providerGroupId,
  });
  if (existing) {
    await db
      .update(scimGroupState)
      .set({ name: input.name, lastSyncedAt: new Date() })
      .where(eq(scimGroupState.id, existing.id));
    const refreshed = await getScimGroupState({
      scimDirectoryId: input.scimDirectoryId,
      providerGroupId: input.providerGroupId,
    });
    if (!refreshed) throw new Error("scim_group_state row vanished after update");
    return refreshed;
  }
  const id = crypto.randomUUID();
  await db.insert(scimGroupState).values({
    id,
    orgId: input.orgId,
    scimDirectoryId: input.scimDirectoryId,
    providerGroupId: input.providerGroupId,
    name: input.name,
  });
  const created = await getScimGroupState({
    scimDirectoryId: input.scimDirectoryId,
    providerGroupId: input.providerGroupId,
  });
  if (!created) throw new Error("scim_group_state row vanished after insert");
  return created;
}

export async function deleteScimGroupState(input: { id: string }): Promise<void> {
  await db.delete(scimGroupState).where(eq(scimGroupState.id, input.id));
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
