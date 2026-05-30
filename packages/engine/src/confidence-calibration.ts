/**
 * Pure math for AI suggestion confidence calibration.
 *
 * LLM patch suggestions self-rate a `confidence` (0-100) that is
 * systematically mis-scaled — the model's "90%" might only earn operator
 * acceptance 60% of the time. This module turns a window of labeled
 * accept/reject decisions (each carrying the raw self-rated confidence it
 * was given) into a linear correction `calibrated = a * raw + b`, and
 * applies that curve at read time.
 *
 * The fit is deliberately simple and robust:
 *   1. Bucket the decisions by raw confidence into fixed-width buckets.
 *   2. For each bucket with at least one sample, take the observed accept
 *      rate as the y-target and the bucket midpoint as the x-input.
 *   3. Least-squares fit a line through those (x, y) points, weighted by
 *      bucket sample count, mapping raw 0-100 → calibrated 0-100.
 *   4. Clamp the applied output to [0, 100].
 *
 * Two guards keep the curve safe:
 *   - `MIN_CALIBRATION_SAMPLES`: below this many total decisions the fit
 *     is unreliable, so `fitCalibrationCurve` returns `null` and the
 *     read side falls back to the raw confidence unchanged.
 *   - **Monotonicity**: a non-positive slope would let calibration invert
 *     the ordering of two suggestions (a lower raw confidence mapping to a
 *     higher calibrated value). `applyCalibration` enforces order by only
 *     trusting a curve with a strictly-positive slope; a degenerate /
 *     inverted fit degrades to raw so suggestion ranking is preserved.
 *
 * Pure — no I/O, no DB, no network. Used by:
 * - `packages/data/src/confidenceCalibrationRepo.ts` — the daily sweep
 *   calls `fitCalibrationCurve` per `(orgId, approachLabel)` bucket and
 *   persists the resulting `{ slope, intercept, sampleSize, acceptRate }`.
 * - `apps/api/src/routes/ai-routes.ts:POST /ai/patch-workflow` — reads the
 *   persisted curve and calls `applyCalibration` to emit both raw and
 *   calibrated confidence per suggestion.
 */

/**
 * Minimum number of accept/reject decisions in the window before a curve
 * is fit. Below this the daily sweep skips the `(orgId, approachLabel)`
 * bucket and the read side shows the raw confidence unchanged.
 */
export const MIN_CALIBRATION_SAMPLES = 20;

/**
 * Width of each raw-confidence bucket, in confidence points. Ten buckets
 * span the 0-100 range (`[0,10)`, `[10,20)`, … `[90,100]`). Wide enough
 * that a handful of decisions per bucket carries signal, narrow enough
 * that the curve can bend across the range.
 */
export const CALIBRATION_BUCKET_WIDTH = 10;

/** A single labeled decision the fit consumes. */
export type CalibrationSample = {
  /** The LLM's self-rated confidence for the suggestion (0-100). */
  rawConfidence: number;
  /** Whether the operator accepted the suggestion. */
  accepted: boolean;
};

/** The fitted linear curve plus the aggregate stats persisted alongside it. */
export type CalibrationCurve = {
  /** Slope `a` in `calibrated = a * raw + b`. Always > 0 when returned. */
  slope: number;
  /** Intercept `b` in `calibrated = a * raw + b`. */
  intercept: number;
  /** Total accept + reject decisions the curve was fit from. */
  sampleSize: number;
  /** Observed accept rate (0..1) across the whole window. */
  acceptRate: number;
};

/** Clamp a value to the inclusive `[lo, hi]` range. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Assign a raw confidence (0-100) to its bucket index. The top edge
 * (100) folds into the final bucket so a perfect self-rating isn't lost
 * to an off-by-one.
 */
function bucketIndex(rawConfidence: number): number {
  const clamped = clamp(rawConfidence, 0, 100);
  const idx = Math.floor(clamped / CALIBRATION_BUCKET_WIDTH);
  const lastBucket = Math.floor(100 / CALIBRATION_BUCKET_WIDTH) - 1;
  return Math.min(idx, lastBucket);
}

/** Midpoint of a bucket index, used as the x-input for the line fit. */
function bucketMidpoint(idx: number): number {
  return idx * CALIBRATION_BUCKET_WIDTH + CALIBRATION_BUCKET_WIDTH / 2;
}

/**
 * Fit a linear calibration curve from a window of labeled decisions.
 *
 * Returns `null` (caller falls back to raw) when:
 *   - fewer than `MIN_CALIBRATION_SAMPLES` total decisions, or
 *   - the surviving buckets don't span enough x-variance to fit a line
 *     (every decision landed in one bucket), or
 *   - the least-squares slope comes out non-positive (a flat or inverted
 *     fit would risk inverting suggestion ordering — better to show raw).
 *
 * The fit weights each bucket by its sample count so a bucket with 50
 * decisions pulls the line harder than a bucket with 2.
 */
export function fitCalibrationCurve(samples: CalibrationSample[]): CalibrationCurve | null {
  if (samples.length < MIN_CALIBRATION_SAMPLES) return null;

  const accepted = samples.filter((s) => s.accepted).length;
  const acceptRate = accepted / samples.length;

  // Aggregate per bucket: count + accepted-count.
  const buckets = new Map<number, { count: number; accepted: number }>();
  for (const sample of samples) {
    const idx = bucketIndex(sample.rawConfidence);
    let bucket = buckets.get(idx);
    if (!bucket) {
      bucket = { count: 0, accepted: 0 };
      buckets.set(idx, bucket);
    }
    bucket.count += 1;
    if (sample.accepted) bucket.accepted += 1;
  }

  // Build weighted (x, y) points: x = bucket midpoint (0-100 scale),
  // y = observed accept rate scaled to 0-100, w = bucket sample count.
  type Point = { x: number; y: number; w: number };
  const points: Point[] = [];
  for (const [idx, bucket] of buckets) {
    points.push({
      x: bucketMidpoint(idx),
      y: (bucket.accepted / bucket.count) * 100,
      w: bucket.count,
    });
  }

  // Need at least two distinct x positions to fit a non-vertical line.
  const distinctX = new Set(points.map((p) => p.x));
  if (distinctX.size < 2) return null;

  // Weighted least-squares: minimise Σ w_i (y_i - (a x_i + b))².
  let sumW = 0;
  let sumWX = 0;
  let sumWY = 0;
  let sumWXX = 0;
  let sumWXY = 0;
  for (const p of points) {
    sumW += p.w;
    sumWX += p.w * p.x;
    sumWY += p.w * p.y;
    sumWXX += p.w * p.x * p.x;
    sumWXY += p.w * p.x * p.y;
  }
  const denom = sumW * sumWXX - sumWX * sumWX;
  if (denom === 0) return null;

  const slope = (sumW * sumWXY - sumWX * sumWY) / denom;
  const intercept = (sumWY - slope * sumWX) / sumW;

  // Monotonicity guard: a non-positive slope means a higher raw
  // confidence does NOT map to a higher calibrated value — applying it
  // could invert the ordering of two suggestions. Refuse the curve so
  // the read side keeps raw confidence (and the natural ordering).
  if (!(slope > 0) || !Number.isFinite(slope) || !Number.isFinite(intercept)) {
    return null;
  }

  return { slope, intercept, sampleSize: samples.length, acceptRate };
}

/**
 * Apply a persisted curve to a single raw confidence, returning the
 * calibrated 0-100 value. A `null` curve (no calibration available, or
 * below the sample threshold) returns the raw value unchanged.
 *
 * Because `fitCalibrationCurve` only ever returns curves with a strictly
 * positive slope, `applyCalibration` is monotonic in `rawConfidence` —
 * if `a < b` then `applyCalibration(a) <= applyCalibration(b)` — so the
 * relative ordering of two suggestions is never inverted by calibration.
 * The output is clamped into `[0, 100]`.
 */
export function applyCalibration(rawConfidence: number, curve: CalibrationCurve | null): number {
  if (!curve) return clamp(Math.round(rawConfidence), 0, 100);
  const calibrated = curve.slope * rawConfidence + curve.intercept;
  return clamp(Math.round(calibrated), 0, 100);
}

/**
 * Threshold (in confidence points) at which the recovery dialog surfaces
 * the "(model self-rated X%)" subtitle. When the calibrated and raw
 * values differ by less than this, the subtitle is suppressed to avoid
 * visual noise for negligible corrections.
 */
export const CALIBRATION_SUBTITLE_DELTA = 10;
