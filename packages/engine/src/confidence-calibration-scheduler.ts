/**
 * Daily sweep that recomputes the AI-suggestion confidence-calibration
 * curve for every opted-in org. For each `(orgId, approachLabel)` pair
 * with enough labeled accept/reject history, it fits a linear curve
 * (`fitCalibrationCurve`) over the rolling window and upserts it into
 * `confidence_calibrations`; the patch route reads those curves to emit a
 * calibrated confidence alongside the model's raw self-rating.
 *
 * Sibling to `audit-logs-retention-scheduler.ts` — same `system:` BullMQ
 * id-prefix convention, same cron-validation + warn-fallback shape, same
 * never-throws posture. Difference is the work: this walks orgs and fits
 * curves rather than purging a table.
 *
 * Used by:
 * - `packages/engine/src/worker.ts` — `registerConfidenceCalibrationScheduler`
 *   at boot; `handleConfidenceCalibrationTrigger` dispatched from the
 *   `Worker` constructor on `job.name === CONFIDENCE_CALIBRATION_JOB_NAME`.
 *
 * Invariants:
 * - The handler NEVER throws — a Postgres outage during the sweep is
 *   caught + logged. The next daily fire is the natural retry (the curve
 *   fit is idempotent — re-running just overwrites the same rows).
 * - The registrar NEVER throws — a `upsertJobScheduler` failure is caught
 *   + logged and reported as `false`.
 * - Per-org failures are isolated: one org's DB error or bad data can't
 *   abort the rest of the sweep.
 * - One system-sentinel audit row per org per fire (`confidence.calibration.computed`)
 *   summarizing how many approaches were fit / skipped — `orgId` carries
 *   the tenant (the per-org summary is tenant-attributed, unlike the
 *   cross-org retention sweeps which use `orgId: "system"`), `userId: null`.
 */

import { auditLogs, db } from "@janusly/db";
import {
  DEFAULT_CALIBRATION_WINDOW_DAYS,
  listCalibratableApproaches,
  listCalibrationSamples,
  listOrgIdsWithCalibrationEnabled,
  upsertCalibration,
} from "@janusly/data";

import { fitCalibrationCurve } from "./confidence-calibration";
import { workflowQueue } from "./queue";
import { validateCronExpression } from "./schedule";

/** Deterministic global id for the BullMQ scheduler. */
export const CONFIDENCE_CALIBRATION_JOB_ID = "system:confidence-calibration";

/** The `job.name` the worker dispatch matches on. */
export const CONFIDENCE_CALIBRATION_JOB_NAME = "confidence-calibration-trigger";

/** 01:30 UTC daily — off-peak, staggered off the retention sweeps so the
 *  per-org loops don't pile onto the same Postgres connection window. */
export const DEFAULT_CONFIDENCE_CALIBRATION_CRON = "30 1 * * *";

/**
 * Resolve the cron pattern from env or fall back to the documented
 * default. Validation failure warn-logs and returns the default — never
 * throws. Pure-functional over `env` so tests can pass a fake.
 */
function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_CONFIDENCE_CALIBRATION_CRON?.trim();
  if (!raw) return DEFAULT_CONFIDENCE_CALIBRATION_CRON;
  try {
    validateCronExpression(raw);
    return raw;
  } catch (err) {
    console.warn(
      "[confidence-calibration] JANUSLY_CONFIDENCE_CALIBRATION_CRON invalid; falling back to default",
      { value: raw, error: err instanceof Error ? err.message : String(err) },
    );
    return DEFAULT_CONFIDENCE_CALIBRATION_CRON;
  }
}

/**
 * Register the daily confidence-calibration sweep with BullMQ. Idempotent
 * via the deterministic `CONFIDENCE_CALIBRATION_JOB_ID` — concurrent worker
 * replicas booting at the same time re-register the same id.
 */
export async function registerConfidenceCalibrationScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    await workflowQueue.upsertJobScheduler(
      CONFIDENCE_CALIBRATION_JOB_ID,
      { pattern },
      { name: CONFIDENCE_CALIBRATION_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[confidence-calibration] upsertJobScheduler failed", {
      jobId: CONFIDENCE_CALIBRATION_JOB_ID,
      err,
    });
    return false;
  }
}

/**
 * Insert a single per-org audit row summarizing the sweep outcome.
 * Best-effort — a failure to write the audit log is caught + logged so
 * the sweep itself stays observable through the regular log path. The
 * metadata is repo-controlled (approach labels + integer counts), not
 * user free text, so the `safePersistPayload` chokepoint is not needed
 * here (same posture as `retention-scheduler.ts`'s per-org audit).
 */
async function writeCalibrationAudit(orgId: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId: null,
      action: "confidence.calibration.computed",
      targetType: null,
      targetId: null,
      metadata,
    });
  } catch (err) {
    console.warn("[confidence-calibration] audit write failed", {
      orgId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Recompute calibration curves for one org. Exported so a future admin
 * "recalibrate now" route can target a single org without waiting for the
 * cron. NEVER throws — per-approach failures degrade to a skip.
 */
export async function runOrgCalibration(
  orgId: string,
  windowDays: number = DEFAULT_CALIBRATION_WINDOW_DAYS,
): Promise<{ fitted: number; skipped: number }> {
  let fitted = 0;
  let skipped = 0;
  const fittedApproaches: string[] = [];
  const skippedApproaches: string[] = [];

  let approaches: string[];
  try {
    approaches = await listCalibratableApproaches(orgId, windowDays);
  } catch (err) {
    console.error("[confidence-calibration] failed to list approaches", { orgId, err });
    return { fitted: 0, skipped: 0 };
  }

  for (const approachLabel of approaches) {
    try {
      const samples = await listCalibrationSamples(orgId, approachLabel, windowDays);
      const curve = fitCalibrationCurve(samples);
      if (!curve) {
        skipped += 1;
        skippedApproaches.push(approachLabel);
        continue;
      }
      await upsertCalibration({
        orgId,
        approachLabel,
        acceptRate: curve.acceptRate,
        sampleSize: curve.sampleSize,
        curveSlope: curve.slope,
        curveIntercept: curve.intercept,
      });
      fitted += 1;
      fittedApproaches.push(approachLabel);
    } catch (err) {
      // Isolate per-approach failures so one bad approach can't abort the org.
      console.error("[confidence-calibration] approach fit failed", { orgId, approachLabel, err });
      skipped += 1;
      skippedApproaches.push(approachLabel);
    }
  }

  // Only audit when there was something to report — an org with zero
  // calibratable approaches produces no row (no noise on the audit log).
  if (fitted > 0 || skipped > 0) {
    await writeCalibrationAudit(orgId, {
      windowDays,
      approachesConsidered: approaches.length,
      fitted,
      skipped,
      fittedApproaches,
      skippedApproaches,
    });
  }

  return { fitted, skipped };
}

/**
 * BullMQ handler. Lists every opted-in org with calibratable feedback and
 * recomputes each sequentially. NEVER throws — a top-level DB error
 * (listing orgs) degrades to a warn log; per-org errors are isolated
 * inside `runOrgCalibration`.
 */
export async function handleConfidenceCalibrationTrigger(): Promise<void> {
  const windowDays = DEFAULT_CALIBRATION_WINDOW_DAYS;
  let orgIds: string[];
  try {
    orgIds = await listOrgIdsWithCalibrationEnabled(windowDays);
  } catch (err) {
    console.error("[confidence-calibration] failed to list enabled orgs", {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let totalFitted = 0;
  let totalSkipped = 0;
  for (const orgId of orgIds) {
    try {
      const result = await runOrgCalibration(orgId, windowDays);
      totalFitted += result.fitted;
      totalSkipped += result.skipped;
    } catch (err) {
      // runOrgCalibration is never-throws, but guard anyway.
      console.error("[confidence-calibration] runOrgCalibration threw — should never happen", { orgId, err });
    }
  }

  console.log(
    `[confidence-calibration] sweep complete — ${orgIds.length} orgs, ${totalFitted} curves fitted, ${totalSkipped} skipped`,
  );
}
