/**
 * Daily cleanup for revocable browser sessions and one-time SSO nonces.
 *
 * Used by `maintenance-jobs.ts`. The handler is intentionally cross-org and
 * never throws; an interrupted sweep safely resumes on the next daily fire.
 */

import { pruneIdentityState, recordSystemAudit } from "@janusly/data";

import { maintenanceQueue } from "./queue";
import { validateCronExpression } from "./schedule";

export const IDENTITY_RETENTION_JOB_ID = "system:identity-retention";
export const IDENTITY_RETENTION_JOB_NAME = "identity-retention-trigger";
export const DEFAULT_IDENTITY_RETENTION_CRON = "0 3 * * *";
export const DEFAULT_IDENTITY_SESSION_RETENTION_DAYS = 7;
export const MIN_IDENTITY_SESSION_RETENTION_DAYS = 1;
export const MAX_IDENTITY_SESSION_RETENTION_DAYS = 90;

function resolveCron(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_IDENTITY_RETENTION_CRON?.trim();
  if (!raw) return DEFAULT_IDENTITY_RETENTION_CRON;
  try {
    validateCronExpression(raw);
    return raw;
  } catch (error) {
    console.warn("[identity-retention] invalid cron; falling back to default", {
      value: raw,
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_IDENTITY_RETENTION_CRON;
  }
}
export function resolveIdentitySessionRetentionDays(env: NodeJS.ProcessEnv): number {
  const raw = env.JANUSLY_IDENTITY_SESSION_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_IDENTITY_SESSION_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)
    || parsed < MIN_IDENTITY_SESSION_RETENTION_DAYS
    || parsed > MAX_IDENTITY_SESSION_RETENTION_DAYS) {
    console.warn("[identity-retention] invalid session retention; falling back to default", {
      value: raw,
      default: DEFAULT_IDENTITY_SESSION_RETENTION_DAYS,
    });
    return DEFAULT_IDENTITY_SESSION_RETENTION_DAYS;
  }
  return parsed;
}

export async function registerIdentityRetentionScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await maintenanceQueue.upsertJobScheduler(
      IDENTITY_RETENTION_JOB_ID,
      { pattern: resolveCron(env) },
      { name: IDENTITY_RETENTION_JOB_NAME, data: {} },
    );
    return true;
  } catch (error) {
    console.error("[identity-retention] scheduler registration failed", { error });
    return false;
  }
}

export async function handleIdentityRetentionTrigger(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const retentionDays = resolveIdentitySessionRetentionDays(env);
  try {
    const result = await pruneIdentityState({
      sessionOlderThan: new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000),
    });
    console.log(
      `[identity-retention] purged ${result.sessionsDeleted} sessions and ${result.noncesDeleted} nonces`,
    );
    await recordSystemAudit({
      orgId: "system",
      action: "auth.session.retention.purged",
      metadata: { ...result, retentionDays },
      logTag: "[identity-retention]",
    });
  } catch (error) {
    console.error("[identity-retention] sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
