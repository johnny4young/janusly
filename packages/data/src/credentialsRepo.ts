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
import type { DbOrTx } from "./audit-tx";

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

/** Outcome of a secret-ref rotation. Never carries the secret value or the
 *  env-var name — callers learn only success (with the new concurrency
 *  token) or why it failed. */
export type RotateCredentialResult =
  | { ok: true; updatedAt: Date }
  | { ok: false; reason: "not_found" | "conflict" };

/**
 * Atomically rotate the `secret_ref` (env-var NAME) of the credential named
 * `name` for an org. When `ifMatchUpdatedAt` is supplied the UPDATE is
 * CAS-guarded on `updated_at` (millisecond precision — see schema): a stale
 * token matches zero rows and returns `conflict`, so a concurrent edit can't
 * be silently clobbered. Multi-tenant scope via `eq(orgId)` — a credential
 * from another org is never touched. The secret VALUE is irrelevant here;
 * only the env-var name (`secretRef`) is stored, exactly as on create.
 */
export async function rotateCredentialSecretRef(input: {
  orgId: string;
  name: string;
  newSecretRef: string;
  ifMatchUpdatedAt?: string | null;
}, tx: DbOrTx = db): Promise<RotateCredentialResult> {
  // `tx` defaults to the module `db`, but callers can pass a transaction
  // handle (from `withAuditTx`) so the secret-ref swap + its audit row
  // commit-or-rollback together.
  const conds = [eq(credentials.orgId, input.orgId), eq(credentials.name, input.name)];
  if (input.ifMatchUpdatedAt) {
    const ifMatchDate = new Date(input.ifMatchUpdatedAt);
    if (Number.isNaN(ifMatchDate.getTime())) {
      const existing = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.orgId, input.orgId), eq(credentials.name, input.name)));
      return { ok: false, reason: existing.length === 0 ? "not_found" : "conflict" };
    }
    conds.push(eq(credentials.updatedAt, ifMatchDate));
  }
  const updated = await tx
    .update(credentials)
    .set({ secretRef: input.newSecretRef, updatedAt: new Date() })
    .where(and(...conds))
    .returning({ updatedAt: credentials.updatedAt });
  const first = updated[0];
  if (first?.updatedAt) return { ok: true, updatedAt: first.updatedAt };
  // Zero rows updated — separate "no such credential" from "stale If-Match".
  const existing = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.orgId, input.orgId), eq(credentials.name, input.name)));
  return { ok: false, reason: existing.length === 0 ? "not_found" : "conflict" };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
