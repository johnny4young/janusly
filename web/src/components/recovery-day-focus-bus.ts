/**
 * "Drill into one day's failures" — a recovery-heatmap cell click on the Home
 * tab asks the recovery queue (mounted lazily under the Runs tab) to filter to
 * that UTC day, spelled as the route `#/runs/day/<YYYY-MM-DD>`.
 *
 * A tiny standalone module so the Home surface can request a focus day
 * WITHOUT statically importing the heavy queue panel. The requested day is
 * read from the route on mount (consume-once) so a click made before the
 * queue mounts still lands, plus a live event for when it is already mounted.
 */
import { readRoute, writeRoute } from '../lib/route'

export const RECOVERY_DAY_FOCUS_EVENT = 'janusly:recovery:day-focus'

function isDayString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function pendingDay(): string | null {
  const route = readRoute()
  return route?.tab === 'runs' && route.focusDay ? route.focusDay : null
}

/** Read AND clear the pending focus day (consume-once). Returns `YYYY-MM-DD` or null. */
export function consumeRecoveryFocusDay(): string | null {
  const day = pendingDay()
  if (day) writeRoute({ tab: 'runs' }, 'replace')
  return day
}

/** Clear a pending handoff only when it still belongs to the mounted queue
 *  that adopted `day`. A newer request must never be consumed by an older
 *  render committing late. */
export function acknowledgeRecoveryFocusDay(day: string): void {
  if (isDayString(day) && pendingDay() === day) writeRoute({ tab: 'runs' }, 'replace')
}

/** Request the recovery queue focus one UTC day — writes the route for a
 *  not-yet-mounted panel and emits the live event for an already-mounted one.
 *  Ignores bad input. */
export function requestRecoveryDayFocus(day: string): void {
  if (!isDayString(day)) return
  writeRoute({ tab: 'runs', focusDay: day })
  window.dispatchEvent(new CustomEvent(RECOVERY_DAY_FOCUS_EVENT, { detail: day }))
}
