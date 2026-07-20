/**
 * Repository for `confidence_calibrations` — the persisted per-`(orgId,
 * approachLabel)` linear curve that maps an LLM's self-rated suggestion
 * confidence onto an empirically-observed accept rate.
 *
 * Two halves of the loop touch this table:
 *   - **Write** (daily sweep): `listCalibrationSamples` pulls the rolling
 *     window of labeled accept/reject decisions per approach from
 *     `recovery_feedback`; the engine fits a curve (`fitCalibrationCurve`
 *     in `@janusly/engine/src/confidence-calibration.ts`); `upsertCalibration`
 *     persists one row per approach. `listOrgIdsWithCalibrationEnabled`
 *     drives which orgs the sweep walks.
 *   - **Read** (patch route): `listCalibrations` returns every stored
 *     curve for an org; the route applies the matching one per suggestion
 *     to emit a calibrated confidence alongside the raw self-rating.
 *
 * Cross-module type shape: the engine's `fitCalibrationCurve` consumes a
 * `CalibrationSample[]` declared in `@janusly/engine` (engine is a higher
 * layer; data must not import from engine). This module re-declares the
 * sample shape locally and the API / engine wire repo → engine through
 * structural typing — same posture as `recoveryMetricsRepo`.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries `eq(confidenceCalibrations.orgId,
 *   orgId)` (or, for the sample read, `eq(recoveryFeedback.orgId, orgId)`);
 *   the unique index leads with `org_id` so a tenant can never read
 *   another tenant's curve. `listOrgIdsWithCalibrationEnabled` is the lone
 *   un-scoped read by design (it discovers which orgs opted in).
 * - The sample read filters `raw_confidence IS NOT NULL` — feedback rows
 *   written before the column landed (and headless callers that omit it)
 *   silently drop out of the fit rather than skewing it toward 0.
 */

import { and, asc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, confidenceCalibrations, orgConfigs, recoveryFeedback } from "@janusly/db";

/** Default rolling window for the calibration fit — matches the 30-day convention used across the recovery surfaces. */
export const DEFAULT_CALIBRATION_WINDOW_DAYS = 30;

/** Hard cap on labeled decisions scanned per approach so a noisy org can't blow the fit's memory. */
const CALIBRATION_SAMPLE_CAP = 5_000;

/** Closed enum mirrored from the patch envelope `approachLabel` set. */
export type CalibrationApproachLabel =
  | "add_retry"
  | "raise_timeout"
  | "swap_secret_ref"
  | "add_approval"
  | "fix_url"
  | "other";

/**
 * One labeled decision, structurally compatible with the engine's
 * `CalibrationSample`. The daily sweep feeds an array of these into
 * `fitCalibrationCurve`.
 */
export type CalibrationSampleRow = {
  rawConfidence: number;
  accepted: boolean;
};

/** A persisted calibration row as the patch route reads it. */
export type StoredCalibration = {
  approachLabel: string;
  acceptRate: number;
  sampleSize: number;
  curveSlope: number;
  curveIntercept: number;
  lastComputedAt: Date | null;
};

/** Inputs `upsertCalibration` persists for one `(orgId, approachLabel)` pair. */
export type CalibrationUpsertInput = {
  orgId: string;
  approachLabel: string;
  acceptRate: number;
  sampleSize: number;
  curveSlope: number;
  curveIntercept: number;
};

/**
 * Pull the rolling window of labeled decisions for one approach within an
 * org. Only rows carrying a non-null `raw_confidence` participate — the
 * curve is fit against the self-rated confidence each suggestion was
 * given, so a row without it has no x-coordinate to bucket. Capped at
 * `CALIBRATION_SAMPLE_CAP` rows (newest first via the org/workflow index
 * ordering is unnecessary here; the fit is order-independent).
 */
export async function listCalibrationSamples(
  orgId: string,
  approachLabel: string,
  windowDays: number = DEFAULT_CALIBRATION_WINDOW_DAYS,
): Promise<CalibrationSampleRow[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      rawConfidence: recoveryFeedback.rawConfidence,
      accepted: recoveryFeedback.accepted,
    })
    .from(recoveryFeedback)
    .where(and(
      eq(recoveryFeedback.orgId, orgId),
      eq(recoveryFeedback.approachLabel, approachLabel),
      isNotNull(recoveryFeedback.rawConfidence),
      gte(recoveryFeedback.createdAt, since),
    ))
    .limit(CALIBRATION_SAMPLE_CAP);

  return rows
    .filter((r): r is { rawConfidence: number; accepted: boolean } => typeof r.rawConfidence === "number")
    .map((r) => ({ rawConfidence: r.rawConfidence, accepted: r.accepted }));
}

/**
 * Distinct `approachLabel`s that have at least one calibratable feedback
 * row (non-null `raw_confidence`) within the window for an org. The daily
 * sweep iterates these so it fits a curve only for approaches the org has
 * actually exercised — no wasted writes for approaches with zero history.
 */
export async function listCalibratableApproaches(
  orgId: string,
  windowDays: number = DEFAULT_CALIBRATION_WINDOW_DAYS,
): Promise<string[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .selectDistinct({ approachLabel: recoveryFeedback.approachLabel })
    .from(recoveryFeedback)
    .where(and(
      eq(recoveryFeedback.orgId, orgId),
      isNotNull(recoveryFeedback.rawConfidence),
      gte(recoveryFeedback.createdAt, since),
    ));
  return rows.map((r) => r.approachLabel);
}

/**
 * Every stored calibration curve for an org. The patch route reads this
 * once per request and looks up the row matching each suggestion's
 * `approachLabel`. Empty array when the org has never been calibrated —
 * the route then emits raw confidence unchanged.
 */
export async function listCalibrations(orgId: string): Promise<StoredCalibration[]> {
  return db
    .select({
      approachLabel: confidenceCalibrations.approachLabel,
      acceptRate: confidenceCalibrations.acceptRate,
      sampleSize: confidenceCalibrations.sampleSize,
      curveSlope: confidenceCalibrations.curveSlope,
      curveIntercept: confidenceCalibrations.curveIntercept,
      lastComputedAt: confidenceCalibrations.lastComputedAt,
    })
    .from(confidenceCalibrations)
    .where(eq(confidenceCalibrations.orgId, orgId))
    // The patch route indexes this array, while the Recovery Center renders
    // it directly. Keep the visible approach rows stable across database
    // plans and refreshes instead of relying on heap order.
    .orderBy(asc(confidenceCalibrations.approachLabel));
}

/**
 * Upsert one calibration row keyed by `(orgId, approachLabel)`. The
 * unique index makes the `ON CONFLICT` deterministic — a re-fit replaces
 * the curve in place and bumps `last_computed_at`.
 */
export async function upsertCalibration(input: CalibrationUpsertInput): Promise<void> {
  await db
    .insert(confidenceCalibrations)
    .values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      approachLabel: input.approachLabel,
      acceptRate: input.acceptRate,
      sampleSize: input.sampleSize,
      curveSlope: input.curveSlope,
      curveIntercept: input.curveIntercept,
      lastComputedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [confidenceCalibrations.orgId, confidenceCalibrations.approachLabel],
      set: {
        acceptRate: input.acceptRate,
        sampleSize: input.sampleSize,
        curveSlope: input.curveSlope,
        curveIntercept: input.curveIntercept,
        lastComputedAt: new Date(),
      },
    });
}

/**
 * Orgs that have NOT opted out of confidence calibration. The feature
 * defaults to on, so the daily sweep should process every org that has
 * recovery feedback — but skip those whose
 * `org_configs.ai.confidenceCalibrationEnabled` is explicitly `false`.
 *
 * Implementation: list distinct org ids that appear in `recovery_feedback`
 * (the only orgs with anything to calibrate), then subtract the set whose
 * config row is explicitly `false`. This is the lone un-scoped read in the
 * module by design — it's the discovery step that feeds the per-org loop.
 */
export async function listOrgIdsWithCalibrationEnabled(
  windowDays: number = DEFAULT_CALIBRATION_WINDOW_DAYS,
): Promise<string[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const feedbackOrgs = await db
    .selectDistinct({ orgId: recoveryFeedback.orgId })
    .from(recoveryFeedback)
    .where(and(
      isNotNull(recoveryFeedback.rawConfidence),
      gte(recoveryFeedback.createdAt, since),
    ));

  const optedOut = await db
    .select({ orgId: orgConfigs.orgId })
    .from(orgConfigs)
    .where(and(
      eq(orgConfigs.key, "ai.confidenceCalibrationEnabled"),
      sql`${orgConfigs.valueJson} = 'false'::jsonb`,
    ));
  const optedOutSet = new Set(optedOut.map((r) => r.orgId));

  return feedbackOrgs
    .map((r) => r.orgId)
    .filter((orgId) => !optedOutSet.has(orgId));
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; the org-discovery read is the documented global exception - see AGENTS.md "AuthContext is Janusly-resolved".
