/**
 * Per-org SSO connection metadata. Used by the membership resolver as the
 * JIT (just-in-time) provisioning seam: when a Supabase principal lacks an
 * `org_members` row AND no invitation / verified-domain match exists AND
 * the target org has an `active` SSO row, the resolver returns `null`
 * (fails closed). A future WorkOS provider runs its OWN JIT-provisioning
 * code path BEFORE the membership resolver, so an SSO-authenticated user
 * arrives at the resolver with a membership already upserted.
 *
 * Multi-tenant scope: every read carries `eq(ssoConnections.orgId, orgId)`.
 * Unique `(orgId, provider)` means at most one row per provider per org.
 *
 * Read-only in this layer for now; writes will land alongside the WorkOS
 * provider.
 *
 * Used by:
 * - `apps/api/src/auth.ts` (resolver JIT-handoff null branch).
 */

import { eq } from "drizzle-orm";
import { db, ssoConnections } from "@janusly/db";

export type SsoConnectionStatus = "active" | "revoked";

export type SsoConnectionRow = {
  id: string;
  orgId: string;
  provider: string;
  providerConnectionId: string;
  status: SsoConnectionStatus;
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
    configJson: (row.configJson as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Return the first SSO connection row for the org, or `null`. Today's
 * unique `(orgId, provider)` constraint paired with the resolver's single
 * call site means we don't need to filter by provider here — the resolver
 * just asks "does this org have any active SSO?".
 */
export async function getSsoConnectionForOrg(orgId: string): Promise<SsoConnectionRow | null> {
  const rows = await db.select().from(ssoConnections).where(eq(ssoConnections.orgId, orgId));
  const row = rows[0];
  return row ? mapRow(row) : null;
}
