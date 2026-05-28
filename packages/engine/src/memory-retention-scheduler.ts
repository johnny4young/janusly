/**
 * Daily sweep that enforces per-row `retain_until` on the memory
 * substrate. Wraps `deleteExpiredMemory({})` (the global-sweep
 * signature — no orgId, the repo handles per-org audit grouping
 * internally) behind a single BullMQ recurring job.
 *
 * This is the FIRST non-tenant recurring job in the codebase. Every
 * pre-existing scheduler is per-org with id shape
 * `schedule:<orgId>:<workflowVersionId>:<nodeId>`; this one uses the
 * `system:` prefix to signal cross-org scope. Future global cron jobs
 * (eval roll-ups, billing reconciliations, etc.) should reuse the
 * prefix.
 *
 * Cadence comes from the `JANUSLY_MEMORY_RETENTION_CRON` env var with
 * a `0 3 * * *` (03:00 UTC daily) default. Validation reuses
 * `validateCronExpression` so a malformed env value falls back to the
 * default with a warn log; the boot path is never blocked by a typo
 * in env.
 *
 * Used by:
 * - `packages/engine/src/worker.ts` — `registerMemoryRetentionScheduler`
 *   at boot (alongside `replayAllScheduleEntries`); `handleMemoryRetentionTrigger`
 *   dispatched from the `Worker` constructor on
 *   `job.name === MEMORY_RETENTION_JOB_NAME`.
 *
 * Invariants:
 * - The handler NEVER throws — a Postgres outage during the sweep is
 *   caught + logged. BullMQ otherwise would mark the recurring job
 *   failed and amplify the noise; the next daily fire is the natural
 *   retry (the WHERE clause is idempotent — still-expired rows just
 *   get picked up next time).
 * - The registrar NEVER throws — a `upsertJobScheduler` failure is
 *   caught + logged and reported as `false`. The boot path continues
 *   even if Redis is misbehaving at startup; the next worker reboot
 *   retries.
 * - Multi-tenant scope: the sweep is intentionally cross-org. The
 *   repo's `deleteExpiredMemory({})` already audits per-org via a
 *   `byOrg` grouping loop — no leak into a single audit row that
 *   mixes tenants.
 */

import {
  deleteExpiredMemory,
} from "@janusly/data";

import { workflowQueue } from "./queue";
import { validateCronExpression } from "./schedule";

/** Deterministic global id for the BullMQ scheduler. The `system:`
 *  prefix is reserved for non-tenant cron jobs. */
export const MEMORY_RETENTION_JOB_ID = "system:memory-retention";

/** The `job.name` the worker dispatch matches on. */
export const MEMORY_RETENTION_JOB_NAME = "memory-retention-trigger";

/** 03:00 UTC daily — runs in the off-peak window for most US/EU clusters
 *  and minimizes collision with workflow schedulers that operators
 *  typically pin to business-hour boundaries. */
export const DEFAULT_MEMORY_RETENTION_CRON = "0 3 * * *";

/**
 * Resolve the cron pattern from env or fall back to the documented
 * default. Pure-functional over `env` so tests can pass a fake.
 *
 * Validation failure (malformed cron) warn-logs and returns the
 * default — never throws. The boot path must not fail because of a
 * typo in a single env var.
 */
function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_MEMORY_RETENTION_CRON?.trim();
  if (!raw) return DEFAULT_MEMORY_RETENTION_CRON;
  try {
    validateCronExpression(raw);
    return raw;
  } catch (err) {
    console.warn(
      "[memory-retention] JANUSLY_MEMORY_RETENTION_CRON invalid; falling back to default",
      { value: raw, error: err instanceof Error ? err.message : String(err) },
    );
    return DEFAULT_MEMORY_RETENTION_CRON;
  }
}

/**
 * Register the daily memory-retention sweep with BullMQ. Idempotent
 * via the deterministic `MEMORY_RETENTION_JOB_ID` — concurrent worker
 * replicas booting at the same time re-register the same id.
 */
export async function registerMemoryRetentionScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    await workflowQueue.upsertJobScheduler(
      MEMORY_RETENTION_JOB_ID,
      { pattern },
      { name: MEMORY_RETENTION_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[memory-retention] upsertJobScheduler failed", {
      jobId: MEMORY_RETENTION_JOB_ID,
      err,
    });
    return false;
  }
}

/**
 * BullMQ handler. Sweeps expired rows across every org and logs the
 * count. The repo's `deleteExpiredMemory({})` writes one
 * `memory.retention.purged` audit row per org with non-zero counts —
 * the audit log is the canonical observable signal.
 */
export async function handleMemoryRetentionTrigger(): Promise<void> {
  try {
    const result = await deleteExpiredMemory({});
    console.log(
      `[memory-retention] sweep complete — purged ${result.entriesPurged} entries`,
    );
  } catch (err) {
    console.error("[memory-retention] sweep failed", { err });
  }
}
