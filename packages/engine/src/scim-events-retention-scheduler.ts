/**
 * Daily sweep that purges expired `scim_processed_events` rows. The
 * table is the WorkOS Directory Sync dedup ledger; the dedup window
 * only needs to outlast WorkOS's retry budget (max ~24h), so anything
 * past a few weeks is dead weight.
 *
 * Sibling to `audit-logs-retention-scheduler.ts` — same shape, same
 * never-throws posture; different table, env knobs, and default
 * window. Runs at 04:00 UTC, after the audit-logs sweep at 02:00, so
 * the two never compete for the same Postgres connection during the
 * off-peak window.
 *
 * Used by:
 * - `packages/engine/src/worker.ts` — `registerScimEventsRetentionScheduler`
 *   at boot; `handleScimEventsRetentionTrigger` dispatched from the
 *   `Worker` constructor on `job.name === SCIM_EVENTS_RETENTION_JOB_NAME`.
 *
 * Invariants:
 * - The handler NEVER throws — a Postgres outage during the sweep is
 *   caught + logged. Next daily fire is the natural retry; the WHERE
 *   clause is idempotent.
 * - The registrar NEVER throws — a `upsertJobScheduler` failure is
 *   caught + logged and reported as `false`. Boot path stays
 *   resilient to a Redis blip at startup.
 * - Retention days are clamped to `[MIN, MAX]` — out-of-range env
 *   warn-logs and falls back to default rather than accepting a typo
 *   (`5` when the operator meant `50`).
 * - The audit row uses `orgId: "system"` + `userId: null` — sweep is
 *   intentionally cross-org.
 */

import {
  recordSystemAudit, pruneOldProcessedEvents } from "@janusly/data";

import { workflowQueue } from "./queue";
import { validateCronExpression } from "./schedule";

export const SCIM_EVENTS_RETENTION_JOB_ID = "system:scim-events-retention";
export const SCIM_EVENTS_RETENTION_JOB_NAME = "scim-events-retention-trigger";

/** 04:00 UTC daily — after the audit-logs sweep at 02:00. */
export const DEFAULT_SCIM_EVENTS_RETENTION_CRON = "0 4 * * *";

/** 90 days — 3x the WorkOS retry window with margin. */
export const DEFAULT_SCIM_EVENTS_RETENTION_DAYS = 90;

/** Floor — 7 days easily outlasts every WorkOS retry budget. */
export const MIN_SCIM_EVENTS_RETENTION_DAYS = 7;

/** Ceiling — a year is more than any dedup use case justifies. */
export const MAX_SCIM_EVENTS_RETENTION_DAYS = 365;

/**
 * Resolve the cron pattern from env or fall back to the documented
 * default. Pure-functional over `env` so tests can pass a fake.
 *
 * Validation failure warn-logs and returns the default — never throws.
 */
function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_SCIM_EVENTS_RETENTION_CRON?.trim();
  if (!raw) return DEFAULT_SCIM_EVENTS_RETENTION_CRON;
  try {
    validateCronExpression(raw);
    return raw;
  } catch (err) {
    console.warn(
      "[scim-events-retention] JANUSLY_SCIM_EVENTS_RETENTION_CRON invalid; falling back to default",
      { value: raw, error: err instanceof Error ? err.message : String(err) },
    );
    return DEFAULT_SCIM_EVENTS_RETENTION_CRON;
  }
}

/**
 * Resolve the retention window from env, clamping into the
 * `[MIN, MAX]` range. Out-of-range or non-numeric warn-logs and
 * returns the default — never throws.
 */
export function resolveScimEventsRetentionDays(env: NodeJS.ProcessEnv): number {
  const raw = env.JANUSLY_SCIM_EVENTS_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_SCIM_EVENTS_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    console.warn(
      "[scim-events-retention] JANUSLY_SCIM_EVENTS_RETENTION_DAYS is not an integer; falling back to default",
      { value: raw, default: DEFAULT_SCIM_EVENTS_RETENTION_DAYS },
    );
    return DEFAULT_SCIM_EVENTS_RETENTION_DAYS;
  }
  if (parsed < MIN_SCIM_EVENTS_RETENTION_DAYS || parsed > MAX_SCIM_EVENTS_RETENTION_DAYS) {
    console.warn(
      "[scim-events-retention] JANUSLY_SCIM_EVENTS_RETENTION_DAYS out of range; falling back to default",
      { value: parsed, min: MIN_SCIM_EVENTS_RETENTION_DAYS, max: MAX_SCIM_EVENTS_RETENTION_DAYS, default: DEFAULT_SCIM_EVENTS_RETENTION_DAYS },
    );
    return DEFAULT_SCIM_EVENTS_RETENTION_DAYS;
  }
  return parsed;
}

/**
 * Register the daily scim-events retention sweep with BullMQ.
 * Idempotent via the deterministic `SCIM_EVENTS_RETENTION_JOB_ID`.
 */
export async function registerScimEventsRetentionScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    await workflowQueue.upsertJobScheduler(
      SCIM_EVENTS_RETENTION_JOB_ID,
      { pattern },
      { name: SCIM_EVENTS_RETENTION_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[scim-events-retention] upsertJobScheduler failed", {
      jobId: SCIM_EVENTS_RETENTION_JOB_ID,
      err,
    });
    return false;
  }
}

/**
 * Insert a single system-sentinel audit row describing the sweep
 * outcome. Best-effort — a failure to write the audit log is caught
 * + logged so the sweep itself stays observable through the regular
 * log path.
 */
function writeSystemAudit(action: string, metadata: Record<string, unknown>): Promise<void> {
  return recordSystemAudit({ orgId: "system", action, metadata, logTag: "[scim-events-retention]" });
}

/**
 * BullMQ handler. Resolves the env knobs, calls the repo helper, and
 * audits the outcome. Never throws.
 */
export async function handleScimEventsRetentionTrigger(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const retentionDays = resolveScimEventsRetentionDays(env);
  const olderThan = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    const result = await pruneOldProcessedEvents({ olderThan });
    console.log(
      `[scim-events-retention] sweep complete — purged ${result.rowsDeleted} rows in ${result.runtimeMs}ms (cutoff ${result.cutoffAt}, capped=${result.cappedByMaxBatches})`,
    );
    await writeSystemAudit("scim.event_log.retention.purged", {
      rowsDeleted: result.rowsDeleted,
      cutoffAt: result.cutoffAt,
      runtimeMs: result.runtimeMs,
      retentionDays,
      cappedByMaxBatches: result.cappedByMaxBatches,
    });
  } catch (err) {
    console.error("[scim-events-retention] sweep failed", { err: err instanceof Error ? err.message : String(err) });
  }
}
