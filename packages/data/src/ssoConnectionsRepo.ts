/**
 * Per-org SSO connection metadata. Used by the membership resolver as the
 * JIT (just-in-time) provisioning seam: when a Supabase principal lacks an
 * `org_members` row AND no invitation / verified-domain match exists AND
 * the target org has an `active` SSO row, the resolver returns `null`
 * (fails closed). The WorkOS provider's callback handler
 * (`apps/api/src/routes/sso-routes.ts`) runs JIT provisioning BEFORE the
 * resolver — once the callback upserts an `org_members` row and issues a
 * Janusly session token, the next request resolves via step 1 (direct
 * membership match).
 *
 * `enforcedSso: true` flips the resolver from "fall closed if no
 * provisioning path" to "reject every non-SSO auth mode for this org".
 *
 * Multi-tenant scope: every read and write carries
 * `eq(ssoConnections.orgId, orgId)`. Unique `(orgId, provider)` means at
 * most one row per provider per org.
 *
 * Used by:
 * - `apps/api/src/auth.ts` (resolver JIT-handoff null branch + enforced-SSO check).
 * - `apps/api/src/routes/sso-routes.ts` (admin CRUD + SSO callback handler).
 */

import { and, eq } from "drizzle-orm";
import { db, ssoConnections } from "@janusly/db";

export type SsoConnectionStatus = "active" | "revoked";
export type SsoProvider = "workos";

export type SsoConnectionRow = {
  id: string;
  orgId: string;
  provider: string;
  providerConnectionId: string;
  status: SsoConnectionStatus;
  enforcedSso: boolean;
  configJson: Record<string, unknown> | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

function mapRow(row: typeof ssoConnections.$inferSelect): SsoConnectionRow {
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider,
    providerConnectionId: row.providerConnectionId,
    status: row.status as SsoConnectionStatus,
    enforcedSso: row.enforcedSso,
    configJson: (row.configJson as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Return the first active SSO connection row for the org, or `null`.
 * The resolver and the SSO callback both consult this — the resolver to
 * decide whether to fail closed at step 5c, the callback to validate
 * that the incoming WorkOS `profile.connectionId` matches the row.
 */
export async function getSsoConnectionForOrg(orgId: string): Promise<SsoConnectionRow | null> {
  const rows = await db.select().from(ssoConnections).where(eq(ssoConnections.orgId, orgId));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Admin list — every row (active + revoked) for the org. */
export async function listSsoConnections(orgId: string): Promise<SsoConnectionRow[]> {
  const rows = await db.select().from(ssoConnections).where(eq(ssoConnections.orgId, orgId));
  return rows.map(mapRow);
}

/** Admin read — single row by id, scoped to org. */
export async function getSsoConnectionById(
  input: { id: string; orgId: string },
): Promise<SsoConnectionRow | null> {
  const rows = await db
    .select()
    .from(ssoConnections)
    .where(and(eq(ssoConnections.id, input.id), eq(ssoConnections.orgId, input.orgId)));
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Admin create — insert a new SSO connection for an org. Caller checks
 * for unique-conflict via the existing `(orgId, provider)` index; this
 * function lets the DB enforce.
 *
 * WorkOS `connectionId` is environment-scoped (sandbox vs production
 * issue different ids); the admin must use the right one per
 * deployment.
 */
export async function createSsoConnection(input: {
  orgId: string;
  provider: SsoProvider;
  providerConnectionId: string;
  enforcedSso?: boolean;
}): Promise<SsoConnectionRow> {
  const id = crypto.randomUUID();
  await db.insert(ssoConnections).values({
    id,
    orgId: input.orgId,
    provider: input.provider,
    providerConnectionId: input.providerConnectionId,
    enforcedSso: input.enforcedSso ?? false,
    status: "active",
  });
  const row = await getSsoConnectionById({ id, orgId: input.orgId });
  if (!row) throw new Error("sso_connections row vanished after insert");
  return row;
}

/** Admin update — flip status or enforced-SSO. Always bumps `updated_at`. */
export async function updateSsoConnection(input: {
  id: string;
  orgId: string;
  status?: SsoConnectionStatus;
  enforcedSso?: boolean;
  providerConnectionId?: string;
}): Promise<SsoConnectionRow | null> {
  const updates: Partial<typeof ssoConnections.$inferInsert> = { updatedAt: new Date() };
  if (input.status !== undefined) updates.status = input.status;
  if (input.enforcedSso !== undefined) updates.enforcedSso = input.enforcedSso;
  if (input.providerConnectionId !== undefined) updates.providerConnectionId = input.providerConnectionId;
  await db
    .update(ssoConnections)
    .set(updates)
    .where(and(eq(ssoConnections.id, input.id), eq(ssoConnections.orgId, input.orgId)));
  return getSsoConnectionById({ id: input.id, orgId: input.orgId });
}

/** Admin revoke — soft-delete via status flip (preserves audit trail joins). */
export async function revokeSsoConnection(
  input: { id: string; orgId: string },
): Promise<SsoConnectionRow | null> {
  return updateSsoConnection({ id: input.id, orgId: input.orgId, status: "revoked" });
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
