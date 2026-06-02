/**
 * Read / delete helpers for `audit_logs`. The INSERT chokepoint lives
 * elsewhere (`apps/api/src/audit.ts` is the canonical write path, plus
 * the inline `writeAudit` helper in `memoryEntriesRepo.ts` for system
 * sweeps that fire from the worker); this module only owns retention
 * pruning.
 *
 * Used by:
 * - `packages/engine/src/audit-logs-retention-scheduler.ts` — daily
 *   cron sweep that calls `deleteExpiredAuditLogs`.
 *
 * Invariants:
 * - The DELETE runs in 10k-row batches so a sweep on a 50M-row table
 *   never holds a long lock — each batch is its own short transaction.
 * - A runaway-safety cap on the number of batches (`maxBatches`) bounds
 *   the worst-case sweep at `batchSize * maxBatches` rows. Default is
 *   1k batches × 10k rows = 10M rows / fire — well above the
 *   ~3.65M rows/year/org steady-state, and stops a malformed
 *   `retentionDays = 0` from spinning forever.
 * - Multi-tenant scope: the sweep is intentionally cross-org (the
 *   audit log isn't tenant-segmented for retention purposes — the SOC2
 *   policy applies system-wide). The caller writes a single
 *   `orgId: "system"` audit row per sweep.
 */

import { db, auditLogs } from "@janusly/db";
import { sql } from "drizzle-orm";

export const DEFAULT_AUDIT_LOGS_RETENTION_BATCH_SIZE = 10_000;
export const DEFAULT_AUDIT_LOGS_RETENTION_MAX_BATCHES = 1_000;

export type DeleteExpiredAuditLogsInput = {
  retentionDays: number;
  /** Rows per DELETE batch. Default 10_000. */
  batchSize?: number;
  /** Hard upper bound on iterations so a misconfigured cutoff
   *  (e.g. `retentionDays = 0`) cannot spin forever. Default 1_000. */
  maxBatches?: number;
};

export type DeleteExpiredAuditLogsResult = {
  /** Total rows removed across all batches. */
  rowsDeleted: number;
  /** ISO timestamp of the cutoff used (`now() - retentionDays`). */
  cutoffAt: string;
  /** Wallclock duration of the entire sweep including all batches. */
  runtimeMs: number;
  /** True if the loop exited because `maxBatches` was reached — means
   *  more rows may still be expired and the next fire will pick them
   *  up. Useful signal for the audit row's metadata. */
  cappedByMaxBatches: boolean;
};

/**
 * Purge `audit_logs` rows older than `retentionDays` days, batched.
 *
 * The DELETE uses a subquery + LIMIT so each round-trip removes at
 * most `batchSize` rows; the loop exits when a batch returns fewer
 * than `batchSize` rows OR when `maxBatches` is reached. The inner
 * SELECT scans `created_at` (the existing
 * `audit_logs_org_created_idx` participates partially; planner uses an
 * Index Scan or Bitmap Index Scan once the table grows past the
 * "tiny" threshold).
 */
export async function deleteExpiredAuditLogs(
  input: DeleteExpiredAuditLogsInput,
): Promise<DeleteExpiredAuditLogsResult> {
  const batchSize = input.batchSize ?? DEFAULT_AUDIT_LOGS_RETENTION_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? DEFAULT_AUDIT_LOGS_RETENTION_MAX_BATCHES;
  const cutoffAt = new Date(Date.now() - input.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const startedAt = Date.now();

  let rowsDeleted = 0;
  let cappedByMaxBatches = false;
  for (let i = 0; i < maxBatches; i += 1) {
    // postgres-js doesn't auto-serialize JS Date objects in bound
    // params — pass the ISO string + `::timestamptz` cast so Postgres
    // does the conversion server-side.
    const result = await db.execute<{ id: string }>(sql`
      DELETE FROM ${auditLogs}
      WHERE ${auditLogs.id} IN (
        SELECT ${auditLogs.id} FROM ${auditLogs}
        WHERE ${auditLogs.createdAt} < ${cutoffAt}::timestamptz
        LIMIT ${batchSize}
      )
      RETURNING ${auditLogs.id}
    `);
    const deletedThisBatch = result.length;
    rowsDeleted += deletedThisBatch;
    // Ordering is load-bearing: the early-return MUST precede the
    // cap-flag set. A sweep that happens to finish exactly on the last
    // iteration with a short batch is NOT capped — there were no more
    // expired rows. Reversing the two `if`s would mis-report
    // `cappedByMaxBatches: true` in that edge case.
    if (deletedThisBatch < batchSize) {
      return { rowsDeleted, cutoffAt, runtimeMs: Date.now() - startedAt, cappedByMaxBatches };
    }
    if (i === maxBatches - 1) {
      cappedByMaxBatches = true;
    }
  }
  return { rowsDeleted, cutoffAt, runtimeMs: Date.now() - startedAt, cappedByMaxBatches };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
