/**
 * Repository for the `credentials` table — operator-managed name → secret-ref
 * bindings used by integration tools (Slack, GitHub, signed webhook, etc.).
 *
 * The actual secret values never live in this table. Each row carries a
 * `secret_ref` string that names an environment variable; the calling tool
 * reads `process.env[secret_ref]` at execute time. The table tracks
 * "operator declared a credential named X of kind Y, pointing at env Z" so
 * workflow JSONs can refer to the credential by name without leaking the
 * env-var name into the persisted DAG.
 *
 * Used by:
 * - `packages/engine/src/integration-tools.ts` — every integration tool's
 *   first step is `getCredentialByName(orgId, kind, name)`.
 *
 * Invariants:
 * - Multi-tenant scope: every query filters by `orgId`. There is no helper
 *   that bypasses the filter.
 * - `kind` is a short stable string (`slack_webhook`, `github_token`,
 *   `webhook_secret`, `postgres`, etc.) controlled by the consuming tool.
 *   The repo doesn't enforce a closed enum so adding a new tool doesn't
 *   require a DB migration.
 */

import { and, eq } from "drizzle-orm";
import { credentials, db } from "@janusly/db";

export type Credential = typeof credentials.$inferSelect;

/**
 * Fetch the credential matching `(orgId, kind, name)`. Returns `null` when
 * the row doesn't exist. Multi-tenant scope is enforced by filtering on
 * `orgId` — a row from another org is never returned even if the name +
 * kind match.
 */
export async function getCredentialByName(
  orgId: string,
  kind: string,
  name: string,
): Promise<Credential | null> {
  const rows = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.orgId, orgId),
        eq(credentials.kind, kind),
        eq(credentials.name, name),
      ),
    );
  return rows[0] ?? null;
}

/**
 * List every credential row for an org. Used by the readiness sidecar
 * + the credential-health snapshot to build a per-org `name → secret_ref`
 * map without N+1 lookups. Multi-tenant scope enforced by the
 * ``eq(credentials.orgId, orgId)`` predicate; no helper bypasses it.
 */
export async function listCredentialsForOrg(orgId: string): Promise<Credential[]> {
  return db
    .select()
    .from(credentials)
    .where(eq(credentials.orgId, orgId));
}
