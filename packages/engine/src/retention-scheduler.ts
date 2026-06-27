/**
 * Daily sweep that enforces per-org configurable retention across the
 * six tenant data families: the five high-volume append-only tables
 * (`run_events`, `audit_logs`, `usage_events`, `recovery_feedback`,
 * `memory_entries`) plus soft-deleted workflow tombstones. Unlike the
 * three standalone sweeps (`audit-logs` / `scim-events` / `memory`
 * retention), this one is per-ORG: it iterates every tenant with
 * retention-eligible data, reads that org's `retention.*` config bounds,
 * and runs one batched DELETE per table scoped to that org.
 *
 * Built ON TOP of the existing retention schedulers (same `system:` id
 * prefix, same `validateCronExpression` warn-fallback, same never-throws
 * posture). The append-only table helpers use the 10k-row batched DELETE
 * + `maxBatches` cap and the per-row `hold_until` legal-hold bypass;
 * soft-deleted workflows use a single atomic deferred-cascade statement
 * keyed by `deleted_at`.
 *
 * Cadence comes from `JANUSLY_RETENTION_CRON` with a `0 5 * * *` UTC
 * default — runs AFTER the audit-logs (02:00), memory (03:00), and
 * scim-events (04:00) sweeps so the off-peak window doesn't pile four
 * DELETE-heavy jobs onto the same Postgres connection at once.
 *
 * Used by:
 * - `packages/engine/src/worker.ts` — `registerRetentionScheduler` at
 *   boot; `handleRetentionTrigger` dispatched from the `Worker`
 *   constructor on `job.name === RETENTION_JOB_NAME`.
 *
 * Invariants:
 * - The handler NEVER throws — a Postgres outage mid-sweep is caught +
 *   logged; the next daily fire is the natural retry (the WHERE clause
 *   is idempotent). A per-org failure is isolated: one org's DB error
 *   does not abort the remaining orgs in the loop.
 * - The registrar NEVER throws — a `upsertJobScheduler` failure is
 *   caught + logged and reported as `false`.
 * - Multi-tenant: the repo helpers carry `org_id = $orgId` on every
 *   DELETE; this scheduler reads each org's bounds in isolation. One org
 *   per `retention.purged` audit row — never a row mixing tenants.
 * - Legal-hold bypass: a future-dated `hold_until` row survives the
 *   append-only table sweeps (the repo helpers add the `(hold_until IS
 *   NULL OR hold_until <= now())` conjunct). Workflow tombstones do not
 *   have hold columns; their recovery window is `deleted_at` +
 *   `retention.deletedWorkflowsDays`.
 * - Export-before-delete: when an exporter is registered via
 *   `setRetentionExporter`, the sweep invokes it (best-effort, never
 *   throws) BEFORE the per-table purge for that org.
 */

import { auditLogs, db } from "@janusly/db";
import {
  deleteExpiredAuditLogsForOrg,
  deleteExpiredMemoryEntriesForOrg,
  deleteExpiredRecoveryFeedbackForOrg,
  deleteExpiredRunEventsForOrg,
  deleteExpiredSoftDeletedWorkflowsForOrg,
  deleteExpiredUsageEventsForOrg,
  getRetentionPolicyConfig,
  listOrgIdsForRetention,
  runRetentionExport,
  type RetentionTable,
} from "@janusly/data";

import { workflowQueue } from "./queue";
import { validateCronExpression } from "./schedule";

/** Deterministic global id for the BullMQ scheduler. The `system:`
 *  prefix is reserved for non-tenant cron jobs. */
export const RETENTION_JOB_ID = "system:retention";

/** The `job.name` the worker dispatch matches on. */
export const RETENTION_JOB_NAME = "retention-trigger";

/** 05:00 UTC daily — after audit-logs (02:00), memory (03:00) and
 *  scim-events (04:00) sweeps so the four don't overlap. */
export const DEFAULT_RETENTION_CRON = "0 5 * * *";

/** The tenant tables/data families the sweep purges, paired with their per-org config
 *  field and the repo helper that purges them. */
const RETENTION_TARGETS: ReadonlyArray<{
  table: RetentionTable;
  configKey:
    | "runEventsDays"
    | "auditLogsDays"
    | "usageEventsDays"
    | "recoveryFeedbackDays"
    | "memoryEntriesDays"
    | "deletedWorkflowsDays";
  purge: typeof deleteExpiredRunEventsForOrg;
}> = [
  { table: "run_events", configKey: "runEventsDays", purge: deleteExpiredRunEventsForOrg },
  { table: "audit_logs", configKey: "auditLogsDays", purge: deleteExpiredAuditLogsForOrg },
  { table: "usage_events", configKey: "usageEventsDays", purge: deleteExpiredUsageEventsForOrg },
  {
    table: "recovery_feedback",
    configKey: "recoveryFeedbackDays",
    purge: deleteExpiredRecoveryFeedbackForOrg,
  },
  {
    table: "memory_entries",
    configKey: "memoryEntriesDays",
    purge: deleteExpiredMemoryEntriesForOrg,
  },
  {
    // Soft-deleted workflows: hard-purge the tombstoned rows + their versions
    // + metadata once `deleted_at` is older than the recovery window.
    table: "workflows",
    configKey: "deletedWorkflowsDays",
    purge: deleteExpiredSoftDeletedWorkflowsForOrg,
  },
];

/**
 * Resolve the cron pattern from env or fall back to the documented
 * default. Pure-functional over `env` so tests can pass a fake.
 * Validation failure warn-logs and returns the default — never throws.
 */
function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_RETENTION_CRON?.trim();
  if (!raw) return DEFAULT_RETENTION_CRON;
  try {
    validateCronExpression(raw);
    return raw;
  } catch (err) {
    console.warn(
      "[retention] JANUSLY_RETENTION_CRON invalid; falling back to default",
      { value: raw, error: err instanceof Error ? err.message : String(err) },
    );
    return DEFAULT_RETENTION_CRON;
  }
}

/**
 * Register the daily per-org retention sweep with BullMQ. Idempotent via
 * the deterministic `RETENTION_JOB_ID` — concurrent worker replicas
 * booting at the same time re-register the same id.
 */
export async function registerRetentionScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    await workflowQueue.upsertJobScheduler(
      RETENTION_JOB_ID,
      { pattern },
      { name: RETENTION_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[retention] upsertJobScheduler failed", { jobId: RETENTION_JOB_ID, err });
    return false;
  }
}

/**
 * Insert a single per-org audit row summarizing the org's sweep
 * outcome. Best-effort — a failure to write the audit log is caught +
 * logged so the sweep itself stays observable through the regular log
 * path. The metadata is repo-controlled (table names + counts), not
 * user-supplied free text, so the `safePersistPayload` chokepoint is not
 * needed at this layer (same posture as the sibling retention sweeps).
 */
async function writeOrgRetentionAudit(orgId: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId: null,
      action: "retention.purged",
      targetType: null,
      targetId: null,
      metadata,
    });
  } catch (err) {
    console.warn("[retention] audit write failed", {
      orgId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export type RetentionTableOutcome = {
  table: RetentionTable;
  retentionDays: number;
  rowsDeleted: number;
  cutoffAt: string;
  cappedByMaxBatches: boolean;
};

/**
 * Sweep one org across all five tables. Reads the org's retention bounds
 * once, runs the export seam (if any) before purging, then purges each
 * table in series and writes one `retention.purged` audit row with the
 * per-table breakdown. Never throws — a per-table failure is captured in
 * the outcome and the loop continues to the next table.
 */
export async function purgeRetentionForOrg(orgId: string): Promise<RetentionTableOutcome[]> {
  const policy = await getRetentionPolicyConfig(orgId);

  // Export-before-delete: give the operator's archiver a chance to
  // snapshot the rows about to be deleted. Best-effort and never throws.
  const exported = await runRetentionExport({
    orgId,
    tables: RETENTION_TARGETS.map((t) => t.table),
    requestedBy: null,
  });

  const outcomes: RetentionTableOutcome[] = [];
  for (const target of RETENTION_TARGETS) {
    const retentionDays = policy[target.configKey];
    try {
      const result = await target.purge({ orgId, retentionDays });
      outcomes.push({
        table: target.table,
        retentionDays,
        rowsDeleted: result.rowsDeleted,
        cutoffAt: result.cutoffAt,
        cappedByMaxBatches: result.cappedByMaxBatches,
      });
    } catch (err) {
      console.error("[retention] per-table purge failed", {
        orgId,
        table: target.table,
        err: err instanceof Error ? err.message : String(err),
      });
      outcomes.push({
        table: target.table,
        retentionDays,
        rowsDeleted: 0,
        cutoffAt: new Date().toISOString(),
        cappedByMaxBatches: false,
      });
    }
  }

  const totalRowsDeleted = outcomes.reduce((sum, o) => sum + o.rowsDeleted, 0);
  await writeOrgRetentionAudit(orgId, {
    totalRowsDeleted,
    exported,
    tables: outcomes,
  });
  return outcomes;
}

/**
 * BullMQ handler. Enumerates every org with retention-eligible data and
 * sweeps each in isolation. Never throws — a failure enumerating orgs or
 * sweeping one org degrades to a warn/error log; the next daily fire is
 * the natural retry.
 */
export async function handleRetentionTrigger(): Promise<void> {
  let orgIds: string[];
  try {
    orgIds = await listOrgIdsForRetention();
  } catch (err) {
    console.error("[retention] failed to enumerate orgs; skipping this fire", {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let totalRows = 0;
  for (const orgId of orgIds) {
    try {
      const outcomes = await purgeRetentionForOrg(orgId);
      totalRows += outcomes.reduce((sum, o) => sum + o.rowsDeleted, 0);
    } catch (err) {
      // purgeRetentionForOrg is already defensive, but belt-and-suspenders:
      // one org's failure must never abort the rest of the loop.
      console.error("[retention] org sweep failed", {
        orgId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  console.log(
    `[retention] sweep complete — purged ${totalRows} rows across ${orgIds.length} orgs`,
  );
}
