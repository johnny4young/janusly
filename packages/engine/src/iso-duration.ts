/**
 * ISO 8601 duration → milliseconds parser.
 *
 * Supports the `PnYnMnDTnHnMnS` form where every component is optional and
 * may be a non-negative number (decimals allowed). Returns `null` when the
 * input doesn't match the grammar — callers (e.g. `time.add` tool) can
 * decide how to surface the error.
 *
 * Approximations: year = 365 days, month = 30 days. Calendar-aware
 * arithmetic is intentionally out of scope; recipes that need exact "3
 * calendar months" should compose `time.parse` + `time.format` + manual
 * adjustment, or wait for a future calendar-aware extension.
 *
 * Used by `tool-registry.ts` (`time.add`).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;
const YEAR_MS = 365 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

const ISO_DURATION_RE = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Convert an ISO 8601 duration to milliseconds. Returns `null` for
 * malformed input, the bare `P`, or `PT`. Negative durations are not
 * supported (the grammar's leading `-` falls outside this regex).
 */
export function parseIsoDuration(value: string): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(ISO_DURATION_RE);
  if (!match) return null;

  const [, years, months, days, hours, minutes, seconds] = match;

  // Reject the empty `P` and `PT` forms — at least one component must be
  // present for the value to mean anything.
  if (!years && !months && !days && !hours && !minutes && !seconds) return null;

  return (
    (years ? Number(years) * YEAR_MS : 0) +
    (months ? Number(months) * MONTH_MS : 0) +
    (days ? Number(days) * DAY_MS : 0) +
    (hours ? Number(hours) * HOUR_MS : 0) +
    (minutes ? Number(minutes) * MINUTE_MS : 0) +
    (seconds ? Number(seconds) * SECOND_MS : 0)
  );
}
