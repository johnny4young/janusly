/**
 * Daily sweep that purges expired `audit_logs` rows. Wraps
 * `deleteExpiredAuditLogs({ retentionDays })` behind a BullMQ
 * recurring job, and writes a single system-sentinel audit row per
 * fire summarizing the result.
 *
 * Sibling to `memory-retention-scheduler.ts` — same `system:` BullMQ
 * id prefix convention, same cron-validation + warn-fallback shape,
 * same never-throws posture. Difference is in the table being purged,
 * the env knob names, and the default retention window.
 *
 * Used by:
 * - `packages/engine/src/worker.ts` — `registerAuditLogsRetentionScheduler`
 *   at boot; `handleAuditLogsRetentionTrigger` dispatched from the
 *   `Worker` constructor on `job.name === AUDIT_LOGS_RETENTION_JOB_NAME`.
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
 * - Retention days are clamped to `[MIN, MAX]` — an out-of-range env
 *   value warn-logs and falls back to the documented default rather
 *   than accepting a typo (`5` when the operator meant `5000`).
 * - The audit row uses `orgId: "system"` + `userId: null` — the sweep
 *   is intentionally cross-org so per-tenant attribution doesn't
 *   apply.
 */

import {
  recordSystemAudit, deleteExpiredAuditLogs } from "@janusly/data";

import { maintenanceQueue } from "./queue";
import { validateCronExpression } from "./schedule";

/** Deterministic global id for the BullMQ scheduler. */
export const AUDIT_LOGS_RETENTION_JOB_ID = "system:audit-logs-retention";

/** The `job.name` the worker dispatch matches on. */
export const AUDIT_LOGS_RETENTION_JOB_NAME = "audit-logs-retention-trigger";

/** 02:00 UTC daily — runs in the off-peak window, before the SCIM
 *  sweep so the two never overlap on the same Postgres connection. */
export const DEFAULT_AUDIT_LOGS_RETENTION_CRON = "0 2 * * *";

/** Two years — common SOC2 evidence retention floor. */
export const DEFAULT_AUDIT_LOGS_RETENTION_DAYS = 730;

/** Floor — a typo of `5` clamps to 30, not five. */
export const MIN_AUDIT_LOGS_RETENTION_DAYS = 30;

/** Ceiling — 10 years is more than any common compliance regime
 *  requires; bigger windows make the table unbounded again. */
export const MAX_AUDIT_LOGS_RETENTION_DAYS = 3_650;

/**
 * Resolve the cron pattern from env or fall back to the documented
 * default. Pure-functional over `env` so tests can pass a fake.
 *
 * Validation failure warn-logs and returns the default — never throws.
 */
function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_AUDIT_LOGS_RETENTION_CRON?.trim();
  if (!raw) return DEFAULT_AUDIT_LOGS_RETENTION_CRON;
  try {
    validateCronExpression(raw);
    return raw;
  } catch (err) {
    console.warn(
      "[audit-logs-retention] JANUSLY_AUDIT_LOGS_RETENTION_CRON invalid; falling back to default",
      { value: raw, error: err instanceof Error ? err.message : String(err) },
    );
    return DEFAULT_AUDIT_LOGS_RETENTION_CRON;
  }
}

/**
 * Resolve the retention window from env, clamping into the
 * `[MIN, MAX]` range. Out-of-range or non-numeric warn-logs and
 * returns the default — never throws.
 */
export function resolveAuditLogsRetentionDays(env: NodeJS.ProcessEnv): number {
  const raw = env.JANUSLY_AUDIT_LOGS_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_AUDIT_LOGS_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    console.warn(
      "[audit-logs-retention] JANUSLY_AUDIT_LOGS_RETENTION_DAYS is not an integer; falling back to default",
      { value: raw, default: DEFAULT_AUDIT_LOGS_RETENTION_DAYS },
    );
    return DEFAULT_AUDIT_LOGS_RETENTION_DAYS;
  }
  if (parsed < MIN_AUDIT_LOGS_RETENTION_DAYS || parsed > MAX_AUDIT_LOGS_RETENTION_DAYS) {
    console.warn(
      "[audit-logs-retention] JANUSLY_AUDIT_LOGS_RETENTION_DAYS out of range; falling back to default",
      { value: parsed, min: MIN_AUDIT_LOGS_RETENTION_DAYS, max: MAX_AUDIT_LOGS_RETENTION_DAYS, default: DEFAULT_AUDIT_LOGS_RETENTION_DAYS },
    );
    return DEFAULT_AUDIT_LOGS_RETENTION_DAYS;
  }
  return parsed;
}

/**
 * Register the daily audit-logs retention sweep with BullMQ.
 * Idempotent via the deterministic `AUDIT_LOGS_RETENTION_JOB_ID` —
 * concurrent worker replicas booting at the same time re-register the
 * same id.
 */
export async function registerAuditLogsRetentionScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    await maintenanceQueue.upsertJobScheduler(
      AUDIT_LOGS_RETENTION_JOB_ID,
      { pattern },
      { name: AUDIT_LOGS_RETENTION_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[audit-logs-retention] upsertJobScheduler failed", {
      jobId: AUDIT_LOGS_RETENTION_JOB_ID,
      err,
    });
    return false;
  }
}

/**
 * Insert a single system-sentinel audit row describing the sweep
 * outcome. Best-effort — a failure to write the audit log is caught
 * + logged so the sweep itself stays observable through the regular
 * log path. Mirrors the inline `writeAudit` helper in
 * `packages/data/src/memoryEntriesRepo.ts`.
 */
function writeSystemAudit(action: string, metadata: Record<string, unknown>): Promise<void> {
  return recordSystemAudit({ orgId: "system", action, metadata, logTag: "[audit-logs-retention]" });
}

/**
 * BullMQ handler. Resolves the env knobs, calls the repo helper, and
 * audits the outcome. Never throws — a Postgres outage during the
 * sweep degrades to a warn log; the next daily fire is the natural
 * retry.
 */
export async function handleAuditLogsRetentionTrigger(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const retentionDays = resolveAuditLogsRetentionDays(env);
  try {
    const result = await deleteExpiredAuditLogs({ retentionDays });
    console.log(
      `[audit-logs-retention] sweep complete — purged ${result.rowsDeleted} rows in ${result.runtimeMs}ms (cutoff ${result.cutoffAt}, capped=${result.cappedByMaxBatches})`,
    );
    await writeSystemAudit("audit_logs.retention.purged", {
      rowsDeleted: result.rowsDeleted,
      cutoffAt: result.cutoffAt,
      runtimeMs: result.runtimeMs,
      retentionDays,
      cappedByMaxBatches: result.cappedByMaxBatches,
    });
  } catch (err) {
    console.error("[audit-logs-retention] sweep failed", { err: err instanceof Error ? err.message : String(err) });
  }
}
