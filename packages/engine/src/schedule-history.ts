/**
 * Pure helpers for the cron-observability heatmap: bucket scheduled-fire
 * timestamps into a day-of-week × hour-of-day grid (GitHub-style heatmap),
 * and preview the next-N fires from a cron expression.
 *
 * The SQL side (collecting the raw fire timestamps + their run status) lives
 * in `@janusly/data/src/scheduleHistoryRepo.ts`; this module is the
 * deterministic, I/O-free aggregator the API route composes on top of it.
 * It lives in `@janusly/engine` rather than `@janusly/data` because the
 * next-fire preview needs `cron-parser` (already an engine dependency, used
 * by `schedule.ts`), and `@janusly/data` deliberately stays free of the
 * cron grammar.
 *
 * Used by:
 * - `apps/api/src/routes/workflows-routes.ts:GET /workflows/:id/schedule-history`.
 *
 * Invariants:
 * - Bucketing is in UTC. Each cell key is `(dayOfWeek 0..6 Sun..Sat, hour
 *   0..23)`. `cron-parser` is DST-safe on its own (it resolves wall-clock
 *   cron fields against the host TZ when computing next fires), but the
 *   HISTORY grid buckets observed UTC instants — there's no DST ambiguity
 *   for an instant that already happened, so we read `getUTCDay()` /
 *   `getUTCHours()` directly and document the UTC framing in the response.
 * - Bounds are enforced by the caller (`MAX_HISTORY_DAYS` / `MAX_FIRE_ROWS`)
 *   AND re-asserted here as a defensive `slice` so a future caller can't
 *   feed an unbounded array into the grid build.
 * - Per-cell `anomaly` flags a (dayOfWeek, hour) slot whose failure rate
 *   diverges sharply ABOVE the window's overall failure rate (see
 *   `isAnomalousCell`) — the operator-meaningful "this slot fails far more
 *   than this schedule normally does" signal that drives the web red-dot
 *   overlay. The baseline is the window aggregate; a time-rolling baseline is
 *   a future refinement behind the same boolean (no response-shape change).
 *   Conservative by construction: a healthy schedule (no failures) and a
 *   uniformly-failing one (no single slot stands out) both leave every cell
 *   `anomaly: false`.
 */

import { CronExpressionParser } from "cron-parser";

/** Maximum lookback window for the heatmap. The AC caps history at 90 days. */
export const MAX_HISTORY_DAYS = 90;

/** Hard ceiling on the number of fire rows the grid will fold, regardless of window. */
export const MAX_FIRE_ROWS = 1000;

/** Default count for the next-fires preview. */
export const DEFAULT_NEXT_FIRES = 5;

/** Upper bound on the next-fires preview so a caller can't request a huge list. */
export const MAX_NEXT_FIRES = 25;

/** One observed schedule fire: when it ran + whether the run succeeded / failed. */
export type ScheduleFire = {
  /** Instant the run was created (the fire), as an ISO-8601 string or `Date`. */
  firedAt: string | Date;
  /**
   * Terminal status of the run this fire produced. `succeeded` counts toward
   * the success ratio; anything in the failed set counts toward failures;
   * everything else (running / waiting / cancelled / unknown) counts only
   * toward the cell total. Pass `null` when the status is unavailable.
   */
  status: string | null;
};

/** One heatmap cell — a (dayOfWeek, hour) bucket with success/fail counts. */
export type ScheduleHeatmapCell = {
  /** 0 = Sunday … 6 = Saturday (UTC). */
  dayOfWeek: number;
  /** 0..23 (UTC). */
  hour: number;
  /** Total fires that landed in this bucket. */
  total: number;
  /** Fires whose run reached `succeeded`. */
  success: number;
  /** Fires whose run reached a failed terminal status. */
  fail: number;
  /**
   * True when this slot's failure rate diverges sharply above the window
   * baseline (see `isAnomalousCell`) — drives the web red-dot overlay.
   * `false` for a healthy schedule and for a uniformly-failing one.
   */
  anomaly: boolean;
};

/** The full bucketed heatmap plus the roll-up totals the UI header shows. */
export type ScheduleHeatmap = {
  /** Sparse list of non-empty cells. Empty history → empty array. */
  cells: ScheduleHeatmapCell[];
  /** Total fires folded into the grid (after the defensive row cap). */
  totalFires: number;
  /** Fires that succeeded. */
  totalSuccess: number;
  /** Fires that failed (terminal failed status). */
  totalFail: number;
  /** Time framing of the buckets — always UTC in v1; surfaced so the UI labels it. */
  timezone: "UTC";
};

/** Terminal run statuses that count as a failure for the success/fail ratio. */
const FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "dead_letter", "error"]);

/**
 * Minimum fires in a cell before its failure rate is trusted for anomaly
 * scoring — a 1-of-1 failure is noise, not a pattern.
 */
export const SCHEDULE_ANOMALY_MIN_SAMPLES = 3;

/** A cell must fail at least this fraction of the time to even be a candidate. */
export const SCHEDULE_ANOMALY_MIN_FAIL_RATE = 0.5;

/**
 * …and its failure rate must exceed the window's overall failure rate by at
 * least this margin. This "divergence above baseline" gate is what keeps a
 * uniformly-failing schedule from lighting up every cell — only a slot that
 * fails markedly more than the schedule's norm is anomalous.
 */
export const SCHEDULE_ANOMALY_BASELINE_MARGIN = 0.25;

/**
 * Decide whether a heatmap cell is an anomaly: a slot whose failure rate is a
 * clear outlier ABOVE the window baseline. Pure — `baselineFailRate` is the
 * window-aggregate `totalFail / totalFires` the caller computes once.
 *
 * Returns `false` below `SCHEDULE_ANOMALY_MIN_SAMPLES` (too few fires to
 * trust), and only `true` when the cell both fails at least
 * `SCHEDULE_ANOMALY_MIN_FAIL_RATE` of the time AND exceeds the baseline by at
 * least `SCHEDULE_ANOMALY_BASELINE_MARGIN`. A healthy schedule (baseline 0,
 * no cell fails) and a uniformly-failing one (every cell ≈ baseline) both
 * yield `false`.
 */
export function isAnomalousCell(cell: ScheduleHeatmapCell, baselineFailRate: number): boolean {
  if (cell.total < SCHEDULE_ANOMALY_MIN_SAMPLES) return false;
  const failRate = cell.fail / cell.total;
  return (
    failRate >= SCHEDULE_ANOMALY_MIN_FAIL_RATE &&
    failRate >= baselineFailRate + SCHEDULE_ANOMALY_BASELINE_MARGIN
  );
}

/**
 * Fold observed fires into a day-of-week × hour-of-day grid (UTC). Skips rows
 * whose `firedAt` doesn't parse. Returns a SPARSE cell list (only buckets with
 * at least one fire) plus the run-status roll-ups; an empty `fires` array
 * yields an empty grid with zeroed totals.
 *
 * Defensively caps the input at `MAX_FIRE_ROWS` so a mis-bounded caller can't
 * push an unbounded array through the fold.
 */
export function bucketScheduleFires(fires: readonly ScheduleFire[]): ScheduleHeatmap {
  const capped = fires.length > MAX_FIRE_ROWS ? fires.slice(0, MAX_FIRE_ROWS) : fires;

  // Key the accumulator by `dayOfWeek * 24 + hour` so the 168 possible
  // buckets collapse to a single integer-keyed map — cheap and order-stable.
  const buckets = new Map<number, ScheduleHeatmapCell>();
  let totalFires = 0;
  let totalSuccess = 0;
  let totalFail = 0;

  for (const fire of capped) {
    const date = fire.firedAt instanceof Date ? fire.firedAt : new Date(fire.firedAt);
    const ms = date.getTime();
    if (!Number.isFinite(ms)) continue; // unparseable timestamp — drop it

    const dayOfWeek = date.getUTCDay();
    const hour = date.getUTCHours();
    const key = dayOfWeek * 24 + hour;

    let cell = buckets.get(key);
    if (!cell) {
      cell = { dayOfWeek, hour, total: 0, success: 0, fail: 0, anomaly: false };
      buckets.set(key, cell);
    }
    cell.total += 1;
    totalFires += 1;

    const status = fire.status;
    if (status === "succeeded") {
      cell.success += 1;
      totalSuccess += 1;
    } else if (status != null && FAILED_STATUSES.has(status)) {
      cell.fail += 1;
      totalFail += 1;
    }
  }

  // Stable ordering: row-major (day, then hour) so the grid renders
  // deterministically and tests can assert on a fixed cell order.
  const cells = [...buckets.values()].sort((a, b) =>
    a.dayOfWeek === b.dayOfWeek ? a.hour - b.hour : a.dayOfWeek - b.dayOfWeek,
  );

  // Flag slots whose failure rate diverges sharply above the window baseline.
  // The baseline is the window-aggregate failure rate; an empty/failure-free
  // grid yields 0, so no cell can be anomalous.
  const baselineFailRate = totalFires > 0 ? totalFail / totalFires : 0;
  for (const cell of cells) {
    cell.anomaly = isAnomalousCell(cell, baselineFailRate);
  }

  return { cells, totalFires, totalSuccess, totalFail, timezone: "UTC" };
}

/**
 * Compute the next `count` fire times for a cron expression as ISO-8601
 * strings. `cron-parser` is DST-safe — it resolves the wall-clock cron fields
 * against the host timezone, so a `0 2 * * *` daily job correctly skips or
 * doubles the 02:00 slot on a DST transition day rather than drifting.
 *
 * Returns an empty array on a malformed expression (never throws) so the
 * route can degrade to "no preview available" instead of 500ing — the cron
 * string was already validated at save time, but a corrupt persisted row
 * shouldn't take the observability surface down.
 */
export function computeNextFires(cronExpression: string, count = DEFAULT_NEXT_FIRES): string[] {
  const n = Math.max(0, Math.min(MAX_NEXT_FIRES, Math.trunc(count)));
  if (n === 0) return [];
  if (typeof cronExpression !== "string" || cronExpression.trim().length === 0) return [];

  try {
    const interval = CronExpressionParser.parse(cronExpression.trim());
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const next = interval.next().toISOString();
      // `toISOString()` is typed `string | null` on the Luxon-backed CronDate;
      // null only for an invalid DateTime, unreachable after a successful
      // parse — guard to satisfy the type and bail cleanly if it ever fires.
      if (next === null) break;
      out.push(next);
    }
    return out;
  } catch {
    return [];
  }
}
