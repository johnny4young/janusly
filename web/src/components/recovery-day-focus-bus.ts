/**
 * "Drill into one day's failures" — a recovery-heatmap cell click in Reports
 * asks the recovery queue (mounted lazily under Activity) to filter to that
 * UTC day, spelled as the route `#/recover/day/<YYYY-MM-DD>`.
 *
 * A tiny standalone module so Reports can request a focus day
 * WITHOUT statically importing the heavy queue panel. The requested day is
 * read from the route on mount (consume-once) so a click made before the
 * queue mounts still lands, plus a live event for when it is already mounted.
 */
import { readRoute, writeRoute } from '../lib/route'

export const RECOVERY_DAY_FOCUS_EVENT = 'janusly:recovery:day-focus'

function isDayString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Read AND clear the pending focus day (consume-once). Returns `YYYY-MM-DD` or null. */
export function consumeRecoveryFocusDay(): string | null {
  const route = readRoute()
  if (!route?.focusDay) return null
  writeRoute({ tab: route.tab }, 'replace')
  return route.focusDay
}

/** Clear a pending handoff only when it still belongs to the mounted queue
 *  that adopted `day`. A newer request must never be consumed by an older
 *  render committing late. */
export function acknowledgeRecoveryFocusDay(day: string): void {
  const route = readRoute()
  if (route && isDayString(day) && route.focusDay === day) writeRoute({ tab: route.tab }, 'replace')
}

/** Request the recovery queue focus one UTC day — writes the route for a
 *  not-yet-mounted panel and emits the live event for an already-mounted one.
 *  Ignores bad input. */
export function requestRecoveryDayFocus(day: string, tab: 'runs' | 'recover' = 'runs'): void {
  if (!isDayString(day)) return
  writeRoute({ tab, focusDay: day })
  window.dispatchEvent(new CustomEvent(RECOVERY_DAY_FOCUS_EVENT, { detail: day }))
}
