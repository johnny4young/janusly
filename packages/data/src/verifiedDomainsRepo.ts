/**
 * Per-org pre-authorized email domains for auto-join on first Supabase
 * sign-in. When a Supabase principal authenticates and its email domain
 * matches a row here for the target org AND no `org_members` row exists,
 * the membership resolver upserts a new member with the row's
 * `defaultRole`.
 *
 * Multi-tenant scope: every read carries `eq(verifiedDomains.orgId, orgId)`.
 * Unique `(orgId, domain)`: an org can't have duplicate rows for the same
 * domain.
 *
 * Used by:
 * - `apps/api/src/auth.ts` (resolver auto-join path).
 */

import { and, eq } from "drizzle-orm";
import { db, verifiedDomains } from "@janusly/db";

export type VerifiedDomainRow = {
  id: string;
  orgId: string;
  domain: string;
  defaultRole: string;
  createdAt: Date | string | null;
};

function mapRow(row: typeof verifiedDomains.$inferSelect): VerifiedDomainRow {
  return {
    id: row.id,
    orgId: row.orgId,
    domain: row.domain,
    defaultRole: row.defaultRole,
    createdAt: row.createdAt,
  };
}

/** Look up the verified-domain row for `(orgId, domain)`. Domain is matched case-insensitively. */
export async function findVerifiedDomain(
  input: { orgId: string; domain: string },
): Promise<VerifiedDomainRow | null> {
  const domain = input.domain.trim().toLowerCase();
  if (!domain) return null;
  const rows = await db
    .select()
    .from(verifiedDomains)
    .where(
      and(eq(verifiedDomains.orgId, input.orgId), eq(verifiedDomains.domain, domain)),
    );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Add a verified domain. Caller is responsible for unique-conflict handling. */
export async function addVerifiedDomain(
  input: { orgId: string; domain: string; defaultRole?: string },
): Promise<VerifiedDomainRow> {
  const domain = input.domain.trim().toLowerCase();
  const id = crypto.randomUUID();
  await db.insert(verifiedDomains).values({
    id,
    orgId: input.orgId,
    domain,
    defaultRole: input.defaultRole ?? "viewer",
  });
  const rows = await db.select().from(verifiedDomains).where(eq(verifiedDomains.id, id));
  const row = rows[0];
  if (!row) throw new Error("verified domain vanished after insert");
  return mapRow(row);
}

/** Remove a verified domain. Caller's `orgId` is enforced via the predicate. */
export async function removeVerifiedDomain(input: { id: string; orgId: string }): Promise<void> {
  await db
    .delete(verifiedDomains)
    .where(and(eq(verifiedDomains.id, input.id), eq(verifiedDomains.orgId, input.orgId)));
}

/** List every verified-domain row for the org. */
export async function listVerifiedDomains(orgId: string): Promise<VerifiedDomainRow[]> {
  const rows = await db
    .select()
    .from(verifiedDomains)
    .where(eq(verifiedDomains.orgId, orgId));
  return rows.map(mapRow);
}
