/**
 * Operator-configured IdP-group → Janusly-role mappings (SCIM v2).
 *
 * The hot-path reader `getScimGroupRoleMappingsMap` backs role derivation
 * in the SCIM event handler; the CRUD functions back the admin routes.
 * Every query is org-scoped (the directory is the tenancy anchor, but the
 * org is always in hand at both call sites so we keep it in the predicate
 * — belt and suspenders on the multi-tenant invariant).
 *
 * Orphan-tolerant: no FK to `scim_group_state` — a stale mapping for a
 * deleted group is simply never matched during derivation.
 *
 * Used by:
 * - `apps/api/src/scim-event-handler.ts` (role derivation).
 * - `apps/api/src/routes/scim-routes.ts` (admin CRUD).
 */

import { and, eq } from "drizzle-orm";
import { db, scimGroupRoleMappings } from "@janusly/db";

/** One row of the IdP-group → built-in-role mapping table. */
export type ScimGroupRoleMappingRow = {
  id: string;
  orgId: string;
  scimDirectoryId: string;
  providerGroupId: string;
  role: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

function mapRow(row: typeof scimGroupRoleMappings.$inferSelect): ScimGroupRoleMappingRow {
  return {
    id: row.id,
    orgId: row.orgId,
    scimDirectoryId: row.scimDirectoryId,
    providerGroupId: row.providerGroupId,
    role: row.role,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** All mappings for one directory, org-scoped. Backs the admin list route. */
export async function listScimGroupRoleMappings(
  orgId: string,
  scimDirectoryId: string,
): Promise<ScimGroupRoleMappingRow[]> {
  const rows = await db
    .select()
    .from(scimGroupRoleMappings)
    .where(
      and(
        eq(scimGroupRoleMappings.orgId, orgId),
        eq(scimGroupRoleMappings.scimDirectoryId, scimDirectoryId),
      ),
    );
  return rows.map(mapRow);
}

/**
 * Hot-path reader for role derivation: `providerGroupId → role` for one
 * directory. Org-scoped. Returns an empty Map when nothing is configured
 * (→ derivation falls back to the directory `defaultRole`, i.e. v1 behavior).
 */
export async function getScimGroupRoleMappingsMap(
  orgId: string,
  scimDirectoryId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(scimGroupRoleMappings)
    .where(
      and(
        eq(scimGroupRoleMappings.orgId, orgId),
        eq(scimGroupRoleMappings.scimDirectoryId, scimDirectoryId),
      ),
    );
  return new Map(rows.map((row) => [row.providerGroupId, row.role]));
}

export async function getScimGroupRoleMappingById(input: {
  id: string;
  orgId: string;
}): Promise<ScimGroupRoleMappingRow | null> {
  const rows = await db
    .select()
    .from(scimGroupRoleMappings)
    .where(and(eq(scimGroupRoleMappings.id, input.id), eq(scimGroupRoleMappings.orgId, input.orgId)));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function findScimGroupRoleMappingByGroup(input: {
  orgId: string;
  scimDirectoryId: string;
  providerGroupId: string;
}): Promise<ScimGroupRoleMappingRow | null> {
  const rows = await db
    .select()
    .from(scimGroupRoleMappings)
    .where(
      and(
        eq(scimGroupRoleMappings.orgId, input.orgId),
        eq(scimGroupRoleMappings.scimDirectoryId, input.scimDirectoryId),
        eq(scimGroupRoleMappings.providerGroupId, input.providerGroupId),
      ),
    );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function createScimGroupRoleMapping(input: {
  orgId: string;
  scimDirectoryId: string;
  providerGroupId: string;
  role: string;
  createdBy?: string | null;
}): Promise<ScimGroupRoleMappingRow> {
  const id = crypto.randomUUID();
  const [created] = await db
    .insert(scimGroupRoleMappings)
    .values({
      id,
      orgId: input.orgId,
      scimDirectoryId: input.scimDirectoryId,
      providerGroupId: input.providerGroupId,
      role: input.role,
      createdBy: input.createdBy ?? null,
      updatedBy: input.createdBy ?? null,
    })
    .returning();
  if (!created) throw new Error("scim_group_role_mappings row vanished after insert");
  return mapRow(created);
}

/** Update an existing mapping's role (by id, org-scoped). Returns null on miss. */
export async function updateScimGroupRoleMapping(input: {
  id: string;
  orgId: string;
  role: string;
  updatedBy?: string | null;
}): Promise<ScimGroupRoleMappingRow | null> {
  const [updated] = await db
    .update(scimGroupRoleMappings)
    .set({ role: input.role, updatedBy: input.updatedBy ?? null, updatedAt: new Date() })
    .where(and(eq(scimGroupRoleMappings.id, input.id), eq(scimGroupRoleMappings.orgId, input.orgId)))
    .returning();
  return updated ? mapRow(updated) : null;
}

/** Hard-delete a mapping (by id, org-scoped). Returns the deleted row count. */
export async function deleteScimGroupRoleMapping(input: { id: string; orgId: string }): Promise<number> {
  const deleted = await db
    .delete(scimGroupRoleMappings)
    .where(and(eq(scimGroupRoleMappings.id, input.id), eq(scimGroupRoleMappings.orgId, input.orgId)))
    .returning({ id: scimGroupRoleMappings.id });
  return deleted.length;
}

// Multi-tenant invariant: every read and write keeps orgId in the predicate.
