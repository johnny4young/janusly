/**
 * Per-org role catalog. Stores BOTH (a) overrides to built-in roles
 * (`viewer`/`editor`/`admin`) and (b) admin-created custom roles
 * (`compliance`, `ops-readonly`, etc.) for the same org.
 *
 * Lookup order at the resolver: row exists with non-null
 * `grantedPermissions` → use it. Built-in with no row OR null
 * permissions → fall back to the catalog defaults. Custom roles
 * always have a row.
 *
 * Multi-tenant scope: every read / write carries
 * `eq(orgRoles.orgId, orgId)`. Unique on `(orgId, name)`.
 *
 * Used by:
 * - `apps/api/src/permissions.ts` (`getEffectivePermissions`).
 * - `apps/api/src/routes/roles-routes.ts` (admin CRUD).
 */

import { and, eq } from "drizzle-orm";
import { db, orgMembers, orgRoles } from "@janusly/db";

export type OrgRoleRow = {
  id: string;
  orgId: string;
  name: string;
  inheritsFrom: string;
  description: string | null;
  isBuiltin: boolean;
  grantedPermissions: string[] | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

function mapRow(row: typeof orgRoles.$inferSelect): OrgRoleRow {
  const permissions = row.grantedPermissions;
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    inheritsFrom: row.inheritsFrom,
    description: row.description,
    isBuiltin: row.isBuiltin,
    grantedPermissions: Array.isArray(permissions) ? (permissions as string[]) : null,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Read a single role by (orgId, name). Returns `null` when no row exists. */
export async function getOrgRole(input: { orgId: string; name: string }): Promise<OrgRoleRow | null> {
  const rows = await db
    .select()
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, input.orgId), eq(orgRoles.name, input.name)));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** List every role row for an org (built-ins with overrides + custom roles). */
export async function listOrgRoles(orgId: string): Promise<OrgRoleRow[]> {
  const rows = await db.select().from(orgRoles).where(eq(orgRoles.orgId, orgId));
  return rows.map(mapRow);
}

/**
 * Create a custom role (or seed a built-in override). Caller is
 * responsible for validating `name` (allowlist regex, length cap)
 * and that `grantedPermissions` are valid catalog keys.
 */
export async function createOrgRole(input: {
  orgId: string;
  name: string;
  inheritsFrom: string;
  description?: string | null;
  isBuiltin: boolean;
  grantedPermissions: string[] | null;
  createdBy?: string | null;
}): Promise<OrgRoleRow> {
  const id = crypto.randomUUID();
  await db.insert(orgRoles).values({
    id,
    orgId: input.orgId,
    name: input.name,
    inheritsFrom: input.inheritsFrom,
    description: input.description ?? null,
    isBuiltin: input.isBuiltin,
    grantedPermissions: input.grantedPermissions ?? null,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
  });
  const created = await getOrgRole({ orgId: input.orgId, name: input.name });
  if (!created) throw new Error("org_roles row vanished after insert");
  return created;
}

/**
 * Replace an existing role row's permission set + optional metadata.
 * Caller validates that the permissions are catalog keys and that
 * `inheritsFrom` is one of the built-in names.
 */
export async function updateOrgRole(input: {
  orgId: string;
  name: string;
  grantedPermissions?: string[] | null;
  description?: string | null;
  inheritsFrom?: string;
  updatedBy?: string | null;
}): Promise<OrgRoleRow | null> {
  const updates: Partial<typeof orgRoles.$inferInsert> = { updatedAt: new Date() };
  if (input.grantedPermissions !== undefined) updates.grantedPermissions = input.grantedPermissions;
  if (input.description !== undefined) updates.description = input.description;
  if (input.inheritsFrom !== undefined) updates.inheritsFrom = input.inheritsFrom;
  if (input.updatedBy !== undefined) updates.updatedBy = input.updatedBy;

  await db
    .update(orgRoles)
    .set(updates)
    .where(and(eq(orgRoles.orgId, input.orgId), eq(orgRoles.name, input.name)));
  return getOrgRole({ orgId: input.orgId, name: input.name });
}

/** Hard-delete a role row by (orgId, name). Caller checks built-in protection + member count. */
export async function deleteOrgRole(input: { orgId: string; name: string }): Promise<void> {
  await db
    .delete(orgRoles)
    .where(and(eq(orgRoles.orgId, input.orgId), eq(orgRoles.name, input.name)));
}

/**
 * Count `org_members` rows whose `role` equals `roleName` in the
 * given org. Used at delete-time to block removal of a role still
 * in use (the admin must re-assign those members first).
 */
export async function countMembersInRole(input: { orgId: string; roleName: string }): Promise<number> {
  const rows = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.role, input.roleName)));
  return rows.length;
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
