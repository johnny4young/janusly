/**
 * Per-org WorkOS-backed Directory Sync connection. One row attaches a
 * WorkOS directory id to an org so inbound SCIM webhook events can be
 * scoped to a tenant. The webhook handler looks up the row by
 * `providerDirectoryId` (sent by WorkOS) and derives `orgId` from it —
 * never trust an upstream-supplied tenancy hint.
 *
 * Multi-tenant scope: every admin-side read and write carries
 * `eq(scimDirectories.orgId, orgId)`. The single un-scoped helper is
 * `getScimDirectoryByProviderDirectoryId`, the webhook entry point;
 * it's effectively a tenancy lookup and is the ONLY caller permitted
 * to read across orgs.
 *
 * Join key invariant (AGENTS.md "SCIM directory sync"): SCIM ops join
 * `org_members` on `(orgId, lower(email))`, not `(orgId, userId)`,
 * because SSO later rewrites legacy email placeholders to provider IDs.
 *
 * Used by:
 * - `apps/api/src/routes/scim-routes.ts` (admin CRUD + webhook entry).
 * - `apps/api/src/scim-event-handler.ts` (sync timestamp).
 */

import { and, eq } from "drizzle-orm";
import { db, scimDirectories } from "@janusly/db";

export type ScimDirectoryStatus = "active" | "revoked";
export type ScimDefaultRole = "viewer" | "editor" | "admin";

export type ScimDirectoryRow = {
  id: string;
  orgId: string;
  providerDirectoryId: string;
  directoryType: string | null;
  defaultRole: ScimDefaultRole;
  status: ScimDirectoryStatus;
  lastSyncedAt: Date | string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

function mapRow(row: typeof scimDirectories.$inferSelect): ScimDirectoryRow {
  return {
    id: row.id,
    orgId: row.orgId,
    providerDirectoryId: row.providerDirectoryId,
    directoryType: row.directoryType,
    defaultRole: row.defaultRole as ScimDefaultRole,
    status: row.status as ScimDirectoryStatus,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Admin read — first directory attached to the org, or `null`. */
export async function getScimDirectoryByOrgId(orgId: string): Promise<ScimDirectoryRow | null> {
  const rows = await db.select().from(scimDirectories).where(eq(scimDirectories.orgId, orgId));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Webhook entry point — derive org from the WorkOS-supplied directory id.
 * NOT scoped to an org because the caller doesn't know which org the
 * event belongs to until this lookup resolves. Returns null when the
 * directory id is unknown (event for a directory we don't have attached);
 * the route logs + 200s so WorkOS stops retrying.
 */
export async function getScimDirectoryByProviderDirectoryId(
  providerDirectoryId: string,
): Promise<ScimDirectoryRow | null> {
  const rows = await db
    .select()
    .from(scimDirectories)
    .where(eq(scimDirectories.providerDirectoryId, providerDirectoryId));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Admin read — by id, scoped to org. */
export async function getScimDirectoryById(input: { id: string; orgId: string }): Promise<ScimDirectoryRow | null> {
  const rows = await db
    .select()
    .from(scimDirectories)
    .where(and(eq(scimDirectories.id, input.id), eq(scimDirectories.orgId, input.orgId)));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Admin list — every row for the org (active + revoked). */
export async function listScimDirectories(orgId: string): Promise<ScimDirectoryRow[]> {
  const rows = await db.select().from(scimDirectories).where(eq(scimDirectories.orgId, orgId));
  return rows.map(mapRow);
}

/** Admin create — attach a new WorkOS directory to the org. */
export async function createScimDirectory(input: {
  orgId: string;
  providerDirectoryId: string;
  directoryType?: string;
  defaultRole?: ScimDefaultRole;
}): Promise<ScimDirectoryRow> {
  const id = crypto.randomUUID();
  await db.insert(scimDirectories).values({
    id,
    orgId: input.orgId,
    providerDirectoryId: input.providerDirectoryId,
    directoryType: input.directoryType ?? null,
    defaultRole: input.defaultRole ?? "viewer",
    status: "active",
  });
  const row = await getScimDirectoryById({ id, orgId: input.orgId });
  if (!row) throw new Error("scim_directories row vanished after insert");
  return row;
}

/** Admin update — flip status or default role. */
export async function updateScimDirectory(input: {
  id: string;
  orgId: string;
  defaultRole?: ScimDefaultRole;
  status?: ScimDirectoryStatus;
  directoryType?: string;
}): Promise<ScimDirectoryRow | null> {
  const updates: Partial<typeof scimDirectories.$inferInsert> = { updatedAt: new Date() };
  if (input.defaultRole !== undefined) updates.defaultRole = input.defaultRole;
  if (input.status !== undefined) updates.status = input.status;
  if (input.directoryType !== undefined) updates.directoryType = input.directoryType;
  await db
    .update(scimDirectories)
    .set(updates)
    .where(and(eq(scimDirectories.id, input.id), eq(scimDirectories.orgId, input.orgId)));
  return getScimDirectoryById({ id: input.id, orgId: input.orgId });
}

/**
 * Admin revoke — HARD-delete the row so the operator can immediately
 * re-attach a different (or the same) WorkOS directory without manual
 * DB intervention. The unique-on-`(orgId)` index would otherwise block
 * a re-attach as long as the revoked row exists. Audit history is
 * preserved in `audit_logs` (the `org.scim.directory_revoked` row
 * carries the metadata); SCIM-provisioned `org_members` rows are NOT
 * touched by revoke (the operator decides whether to clean them up).
 */
export async function revokeScimDirectory(input: { id: string; orgId: string }): Promise<void> {
  await db
    .delete(scimDirectories)
    .where(and(eq(scimDirectories.id, input.id), eq(scimDirectories.orgId, input.orgId)));
}

/** Bump `lastSyncedAt` to now. Called after every accepted webhook event. */
export async function recordScimDirectorySync(input: { id: string; orgId: string }): Promise<void> {
  await db
    .update(scimDirectories)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(scimDirectories.id, input.id), eq(scimDirectories.orgId, input.orgId)));
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
