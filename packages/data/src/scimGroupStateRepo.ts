/**
 * Per-(directory, IdP-side group) state — a mirror of group existence +
 * name. The companion `scim_group_role_mappings` table maps a group to a
 * built-in role; this repo's `listScimGroupState` is the source the admin
 * group→role picker validates against (the operator selects a synced group
 * by name instead of typing a raw `directory_group_…` id).
 *
 * Used by:
 * - `apps/api/src/scim-event-handler.ts` (group event handlers).
 * - `apps/api/src/routes/scim-routes.ts` (GET /org/scim/groups — the picker source).
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

/**
 * All synced groups for one directory, org-scoped. Backs the admin
 * group→role mapping picker (`GET /org/scim/groups`). Capped defensively
 * like Janusly's other list endpoints; large IdP directories should page
 * before flowing into a single select.
 */
export const SCIM_GROUP_STATE_DEFAULT_LIMIT = 100;
export const SCIM_GROUP_STATE_MAX_LIMIT = 200;

export async function listScimGroupState(
  orgId: string,
  scimDirectoryId: string,
  limit = SCIM_GROUP_STATE_DEFAULT_LIMIT,
): Promise<ScimGroupStateRow[]> {
  const safeLimit = Math.min(
    SCIM_GROUP_STATE_MAX_LIMIT,
    Math.max(1, Math.floor(limit)),
  );
  const rows = await db
    .select()
    .from(scimGroupState)
    .where(
      and(
        eq(scimGroupState.orgId, orgId),
        eq(scimGroupState.scimDirectoryId, scimDirectoryId),
      ),
    )
    .limit(safeLimit);
  return rows.map(mapRow);
}

export async function deleteScimGroupState(input: { id: string }): Promise<void> {
  await db.delete(scimGroupState).where(eq(scimGroupState.id, input.id));
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
