/**
 * Per-org retention purge helpers. Each function deletes expired rows
 * for ONE table scoped to a single `orgId`, batched so a sweep on a
 * large table never holds a long lock, and bounded by a `maxBatches`
 * runaway-safety cap.
 *
 * Sibling to `auditLogsRepo.deleteExpiredAuditLogs` /
 * `scimProcessedEventsRepo.pruneOldProcessedEvents` — same 10k-row
 * batched-DELETE shape and the same `{ rowsDeleted, cutoffAt, runtimeMs,
 * cappedByMaxBatches }` result envelope. The difference is these are
 * per-org (the AGENTS multi-tenant invariant — every DELETE carries
 * `org_id = $orgId`) and they honour the per-row `hold_until` legal-hold
 * bypass: a row whose `hold_until` is in the future is exempt from the
 * sweep until the timestamp passes.
 *
 * Used by:
 * - `packages/engine/src/retention-scheduler.ts` — the daily cron sweep
 *   that reads each org's `retention.*` config bounds and calls these
 *   helpers per table.
 *
 * Invariants:
 * - Multi-tenant: every DELETE filters `org_id = $orgId`. `run_events`
 *   has no `org_id` column, so its purge scopes through the parent
 *   `runs.org_id` via a correlated subquery — the only join in this
 *   module, and still org-bounded.
 * - Legal-hold bypass: for append-only tenant tables, `(hold_until IS
 *   NULL OR hold_until <= now())` is a conjunct on every DELETE. A
 *   future-dated `hold_until` survives the sweep. Workflow tombstones
 *   are the exception: they have no `hold_until` column and are purged by
 *   `deleted_at` after the restore window expires.
 * - The DELETE runs in `batchSize` (default 10k) row batches, each its
 *   own short transaction; the loop exits when a batch returns fewer
 *   than `batchSize` rows OR `maxBatches` (default 1k → 10M-row ceiling)
 *   is reached.
 * - Cascade posture: orphan-tolerant (Janusly has no FK constraints).
 *   Purging `run_events` does not touch the parent `runs` row; purging
 *   `audit_logs` does not chase `metadata.runId` references. This is
 *   intentional — older snapshots referencing a deleted row stay
 *   inspectable. The `hold_until` bypass is the safety valve for rows an
 *   active investigation still needs.
 */

import {
  db,
  auditLogs,
  memoryEntries,
  recoveryFeedback,
  runEvents,
  runs,
  usageEvents,
  workflows,
  workflowVersions,
  workflowMetadata,
} from "@janusly/db";
import { sql } from "drizzle-orm";

export const DEFAULT_RETENTION_BATCH_SIZE = 10_000;
export const DEFAULT_RETENTION_MAX_BATCHES = 1_000;

/** Closed enum of tables the daily sweep purges per org. */
export type RetentionTable =
  | "run_events"
  | "audit_logs"
  | "usage_events"
  | "recovery_feedback"
  | "memory_entries"
  | "workflows";

export type DeleteExpiredForOrgInput = {
  orgId: string;
  /** Rows whose `created_at` is strictly older than this many days are
   *  eligible for purge (subject to the `hold_until` bypass). */
  retentionDays: number;
  /** Rows per DELETE batch. Default 10_000. */
  batchSize?: number;
  /** Hard upper bound on iterations so a misconfigured cutoff cannot
   *  spin forever. Default 1_000 → 10M-row sweep ceiling. */
  maxBatches?: number;
};

export type DeleteExpiredForOrgResult = {
  /** Total rows removed across all batches. */
  rowsDeleted: number;
  /** ISO timestamp of the cutoff used (`now() - retentionDays`). */
  cutoffAt: string;
  /** Wallclock duration of the entire sweep including all batches. */
  runtimeMs: number;
  /** True if the loop exited because `maxBatches` was reached — more
   *  rows may still be expired; next fire continues. */
  cappedByMaxBatches: boolean;
};

function cutoffIso(retentionDays: number): string {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Shared batched-DELETE driver. The caller supplies a function that,
 * given the cutoff ISO string + the batch size, returns the inner
 * `DELETE ... RETURNING` query. We loop the query until a short batch or
 * the `maxBatches` cap.
 *
 * `executeBatch` returns the number of rows the batch deleted.
 */
async function runBatchedPurge(
  input: DeleteExpiredForOrgInput,
  executeBatch: (cutoffAtIso: string, batchSize: number) => Promise<number>,
): Promise<DeleteExpiredForOrgResult> {
  const batchSize = input.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? DEFAULT_RETENTION_MAX_BATCHES;
  const cutoffAt = cutoffIso(input.retentionDays);
  const startedAt = Date.now();

  let rowsDeleted = 0;
  let cappedByMaxBatches = false;
  for (let i = 0; i < maxBatches; i += 1) {
    const deletedThisBatch = await executeBatch(cutoffAt, batchSize);
    rowsDeleted += deletedThisBatch;
    // Ordering is load-bearing (mirrors auditLogsRepo): the short-batch
    // early-return MUST precede the cap-flag set, so a sweep that finishes
    // exactly on the last iteration with a short batch is NOT mis-reported
    // as capped.
    if (deletedThisBatch < batchSize) {
      return { rowsDeleted, cutoffAt, runtimeMs: Date.now() - startedAt, cappedByMaxBatches };
    }
    if (i === maxBatches - 1) {
      cappedByMaxBatches = true;
    }
  }
  return { rowsDeleted, cutoffAt, runtimeMs: Date.now() - startedAt, cappedByMaxBatches };
}

/**
 * Purge `run_events` older than `retentionDays` for one org. Scopes by
 * the parent `runs.org_id` (run_events has no org column) and honours
 * `hold_until`. postgres-js doesn't auto-serialize JS Dates, so the
 * cutoff is passed as an ISO string + `::timestamptz` cast.
 */
export async function deleteExpiredRunEventsForOrg(
  input: DeleteExpiredForOrgInput,
): Promise<DeleteExpiredForOrgResult> {
  return runBatchedPurge(input, async (cutoffAtIso, batchSize) => {
    const result = await db.execute<{ id: string }>(sql`
      DELETE FROM ${runEvents}
      WHERE ${runEvents.id} IN (
        SELECT ${runEvents.id} FROM ${runEvents}
        JOIN ${runs} ON ${runs.id} = ${runEvents.runId}
        WHERE ${runs.orgId} = ${input.orgId}
          AND ${runEvents.createdAt} < ${cutoffAtIso}::timestamptz
          AND (${runEvents.holdUntil} IS NULL OR ${runEvents.holdUntil} <= now())
        LIMIT ${batchSize}
      )
      RETURNING ${runEvents.id}
    `);
    return result.length;
  });
}

/** Purge `audit_logs` older than `retentionDays` for one org. */
export async function deleteExpiredAuditLogsForOrg(
  input: DeleteExpiredForOrgInput,
): Promise<DeleteExpiredForOrgResult> {
  return runBatchedPurge(input, async (cutoffAtIso, batchSize) => {
    const result = await db.execute<{ id: string }>(sql`
      DELETE FROM ${auditLogs}
      WHERE ${auditLogs.id} IN (
        SELECT ${auditLogs.id} FROM ${auditLogs}
        WHERE ${auditLogs.orgId} = ${input.orgId}
          AND ${auditLogs.createdAt} < ${cutoffAtIso}::timestamptz
          AND (${auditLogs.holdUntil} IS NULL OR ${auditLogs.holdUntil} <= now())
        LIMIT ${batchSize}
      )
      RETURNING ${auditLogs.id}
    `);
    return result.length;
  });
}

/** Purge `usage_events` older than `retentionDays` for one org. */
export async function deleteExpiredUsageEventsForOrg(
  input: DeleteExpiredForOrgInput,
): Promise<DeleteExpiredForOrgResult> {
  return runBatchedPurge(input, async (cutoffAtIso, batchSize) => {
    const result = await db.execute<{ id: string }>(sql`
      DELETE FROM ${usageEvents}
      WHERE ${usageEvents.id} IN (
        SELECT ${usageEvents.id} FROM ${usageEvents}
        WHERE ${usageEvents.orgId} = ${input.orgId}
          AND ${usageEvents.createdAt} < ${cutoffAtIso}::timestamptz
          AND (${usageEvents.holdUntil} IS NULL OR ${usageEvents.holdUntil} <= now())
        LIMIT ${batchSize}
      )
      RETURNING ${usageEvents.id}
    `);
    return result.length;
  });
}

/** Purge `recovery_feedback` older than `retentionDays` for one org. */
export async function deleteExpiredRecoveryFeedbackForOrg(
  input: DeleteExpiredForOrgInput,
): Promise<DeleteExpiredForOrgResult> {
  return runBatchedPurge(input, async (cutoffAtIso, batchSize) => {
    const result = await db.execute<{ id: string }>(sql`
      DELETE FROM ${recoveryFeedback}
      WHERE ${recoveryFeedback.id} IN (
        SELECT ${recoveryFeedback.id} FROM ${recoveryFeedback}
        WHERE ${recoveryFeedback.orgId} = ${input.orgId}
          AND ${recoveryFeedback.createdAt} < ${cutoffAtIso}::timestamptz
          AND (${recoveryFeedback.holdUntil} IS NULL OR ${recoveryFeedback.holdUntil} <= now())
        LIMIT ${batchSize}
      )
      RETURNING ${recoveryFeedback.id}
    `);
    return result.length;
  });
}

/**
 * Purge `memory_entries` older than `retentionDays` (by `created_at`)
 * for one org. This is the org-level retention floor; the per-kind
 * `retain_until` sweep in `memoryEntriesRepo.deleteExpiredMemory` is a
 * separate, complementary axis. Honours `hold_until`.
 */
export async function deleteExpiredMemoryEntriesForOrg(
  input: DeleteExpiredForOrgInput,
): Promise<DeleteExpiredForOrgResult> {
  return runBatchedPurge(input, async (cutoffAtIso, batchSize) => {
    const result = await db.execute<{ id: string }>(sql`
      DELETE FROM ${memoryEntries}
      WHERE ${memoryEntries.id} IN (
        SELECT ${memoryEntries.id} FROM ${memoryEntries}
        WHERE ${memoryEntries.orgId} = ${input.orgId}
          AND ${memoryEntries.createdAt} < ${cutoffAtIso}::timestamptz
          AND (${memoryEntries.holdUntil} IS NULL OR ${memoryEntries.holdUntil} <= now())
        LIMIT ${batchSize}
      )
      RETURNING ${memoryEntries.id}
    `);
    return result.length;
  });
}

/**
 * Hard-purge workflows soft-deleted (`deletedAt` set) longer than
 * `retentionDays` for one org, plus their `workflow_versions` +
 * `workflow_metadata` rows — the original delete cascade, deferred by the
 * soft-delete tombstone. Runs / audit rows stay (orphan-tolerant, no FK).
 * Unlike the high-volume `created_at` sweeps this filters on `deleted_at`
 * and is single-statement (soft-deleted workflows are low-cardinality), so
 * it doesn't use the batched driver. The child + parent deletes must stay
 * atomic: if the process dies mid-purge, a workflow must never be restored
 * without its version history.
 */
export async function deleteExpiredSoftDeletedWorkflowsForOrg(
  input: DeleteExpiredForOrgInput,
): Promise<DeleteExpiredForOrgResult> {
  const startedAt = Date.now();
  const cutoffAt = cutoffIso(input.retentionDays);
  // One data-modifying CTE keeps the deferred cascade atomic: either the
  // tombstoned workflows and their child rows all purge, or none do.
  const deleted = await db.execute<{ rows_deleted: number | string }>(sql`
    WITH expired_workflows AS (
      SELECT ${workflows.id}
      FROM ${workflows}
      WHERE ${workflows.orgId} = ${input.orgId}
        AND ${workflows.deletedAt} IS NOT NULL
        AND ${workflows.deletedAt} <= ${cutoffAt}::timestamptz
    ),
    deleted_versions AS (
      DELETE FROM ${workflowVersions}
      WHERE ${workflowVersions.orgId} = ${input.orgId}
        AND ${workflowVersions.workflowId} IN (SELECT id FROM expired_workflows)
      RETURNING 1
    ),
    deleted_metadata AS (
      DELETE FROM ${workflowMetadata}
      WHERE ${workflowMetadata.orgId} = ${input.orgId}
        AND ${workflowMetadata.workflowId} IN (SELECT id FROM expired_workflows)
      RETURNING 1
    ),
    deleted_workflows AS (
      DELETE FROM ${workflows}
      WHERE ${workflows.orgId} = ${input.orgId}
        AND ${workflows.id} IN (SELECT id FROM expired_workflows)
      RETURNING ${workflows.id}
    )
    SELECT count(*)::int AS rows_deleted FROM deleted_workflows
  `);
  const rowsDeleted = Number(deleted[0]?.rows_deleted ?? 0);
  return { rowsDeleted, cutoffAt, runtimeMs: Date.now() - startedAt, cappedByMaxBatches: false };
}

/**
 * Enumerate every distinct org that has retention-eligible data in any
 * of the swept tables. The daily sweep iterates this list and reads each
 * org's `retention.*` bounds. `run_events` is reached through `runs`
 * (its tenant owner). The UNION dedups across tables so an org with rows
 * in multiple tables appears once.
 *
 * The `system` sentinel org (used by global-cron audit rows and the
 * rate-limiter degradation tracker) is excluded — those rows are
 * operator infrastructure, not tenant data, and are governed by the
 * standalone `audit-logs-retention-scheduler` floor, not per-org config.
 */
export async function listOrgIdsForRetention(): Promise<string[]> {
  const result = await db.execute<{ org_id: string }>(sql`
    SELECT DISTINCT org_id FROM (
      SELECT ${runs.orgId} AS org_id FROM ${runs}
      UNION
      SELECT ${auditLogs.orgId} AS org_id FROM ${auditLogs}
      UNION
      SELECT ${usageEvents.orgId} AS org_id FROM ${usageEvents}
      UNION
      SELECT ${recoveryFeedback.orgId} AS org_id FROM ${recoveryFeedback}
      UNION
      SELECT ${memoryEntries.orgId} AS org_id FROM ${memoryEntries}
      UNION
      SELECT ${workflows.orgId} AS org_id FROM ${workflows} WHERE ${workflows.deletedAt} IS NOT NULL
    ) AS orgs
    WHERE org_id <> 'system'
  `);
  return result.map((row) => row.org_id);
}

// ─── Export-before-delete seam ──────────────────────────────────────────────

export type RetentionExportRequest = {
  orgId: string;
  /** The tables the operator wants archived before the next purge. */
  tables: RetentionTable[];
  /** Optional explicit cutoff; defaults to "everything currently
   *  expired" computed by the sweep from per-table retention days. */
  beforeIso?: string;
  /** Who requested the export (audit attribution). */
  requestedBy?: string | null;
};

export type RetentionExporter = (request: RetentionExportRequest) => Promise<void>;

let exporter: RetentionExporter | null = null;

/**
 * DI seam for the export-before-delete workflow. An operator can wire an
 * archiver (S3 cold-store dump, compliance vault, etc.) here; the daily
 * sweep calls `runRetentionExport` BEFORE the per-table purge so the
 * archive captures rows about to be deleted. Unset = no export step
 * (the default — purge runs without archiving).
 *
 * Mirrors the other DI seams in this package (`setUsageRecorder`,
 * `setRecoveryItemCreator`): registered once at boot, fire-and-forget,
 * never load-bearing for the purge itself.
 */
export function setRetentionExporter(fn: RetentionExporter | null): void {
  exporter = fn;
}

/**
 * Invoke the registered export seam if one is set. Never throws — an
 * export-archiver fault must not block the purge (the purge is the
 * compliance-load-bearing operation; the export is best-effort defense
 * for operators who opted into archiving). Returns whether an exporter
 * actually ran.
 */
export async function runRetentionExport(request: RetentionExportRequest): Promise<boolean> {
  if (!exporter) return false;
  try {
    await exporter(request);
    return true;
  } catch (err) {
    console.warn("[retention] export seam threw; proceeding with purge", {
      orgId: request.orgId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
