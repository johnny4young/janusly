/**
 * Timezone-aware weekday/time-of-day window matching.
 *
 * The two hard parts of "is this instant inside a recurring local window" —
 * resolving an instant to a wall clock in an IANA zone, and windows that cross
 * midnight — live here once so callers cannot drift apart.
 *
 * Used by:
 * - `packages/engine/src/tools/time.ts` — the generic `time.window` tool,
 *   which REJECTS malformed configuration (a decision primitive must never
 *   answer from bad input).
 * - `packages/engine/src/integration-tools.ts` — the PagerDuty off-hours
 *   evaluator, which deliberately treats malformed configuration as "inside
 *   working hours" so a broken policy can never authorize a mutation.
 *
 * Those two fail postures are opposite ON PURPOSE. This module stays neutral:
 * it validates and reports, and each caller decides what invalid means.
 */

/** Wall clock inside a target zone: weekday (0=Sunday) + minutes since local midnight. */
export type ZonedClock = { day: number; minute: number };

/** One recurring local window. `days` uses 0=Sunday..6=Saturday. */
export type LocalWindow = { days: number[]; start: string; end: string };

/** Parse `HH:MM` (24h) into minutes since midnight, or null when malformed. */
export function parseLocalMinute(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Resolve an instant to its wall clock in `timeZone`.
 *
 * Returns null for an unknown/invalid zone (Intl throws) or unparseable parts,
 * so callers choose the failure semantics rather than catching here.
 */
export function zonedClock(date: Date, timeZone: string): ZonedClock | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const days: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const day = days[values.weekday ?? ""];
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    return day === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)
      ? null
      : { day, minute: hour * 60 + minute };
  } catch {
    return null;
  }
}

/**
 * True when `clock` falls inside the window bounded by `startMinute` (inclusive)
 * and `endMinute` (exclusive) on one of `days`.
 *
 * A window whose end is before its start crosses midnight: it opens on a listed
 * day and closes on the following calendar day, so the tail is matched against
 * the PREVIOUS day's membership. `start === end` is rejected upstream — it is
 * ambiguous between an empty window and a full day.
 */
export function windowContains(
  clock: ZonedClock,
  days: readonly number[],
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute < endMinute) {
    return days.includes(clock.day) && clock.minute >= startMinute && clock.minute < endMinute;
  }
  const previousDay = (clock.day + 6) % 7;
  return (
    (days.includes(clock.day) && clock.minute >= startMinute)
    || (days.includes(previousDay) && clock.minute < endMinute)
  );
}
