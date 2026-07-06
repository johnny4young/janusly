/**
 * Cross-component bus for "drill into one day's failures" — a recovery-heatmap
 * cell click on the Home tab asks the recovery queue (mounted lazily under the
 * Runs tab) to filter to that UTC day.
 *
 * Mirrors `operations-section-bus`: a tiny standalone module so the Home
 * surface can request a focus day WITHOUT statically importing the heavy queue
 * panel. The requested day is a consume-once handoff (sessionStorage) so a
 * click made before the queue mounts still lands, plus a live event for when it
 * is already mounted.
 */

const STORAGE_KEY = 'janusly:recovery:focus-day'
export const RECOVERY_DAY_FOCUS_EVENT = 'janusly:recovery:day-focus'

function isDayString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Read AND clear the pending focus day (consume-once). Returns `YYYY-MM-DD` or null. */
export function consumeRecoveryFocusDay(): string | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (raw) window.sessionStorage.removeItem(STORAGE_KEY)
    return isDayString(raw) ? raw : null
  } catch {
    return null
  }
}

/** Request the recovery queue focus one UTC day — stashes it for a not-yet-mounted
 *  panel and emits the live event for an already-mounted one. Ignores bad input. */
export function requestRecoveryDayFocus(day: string): void {
  if (!isDayString(day)) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, day)
  } catch {
    // sessionStorage unavailable — the live event below still covers a mounted panel.
  }
  window.dispatchEvent(new CustomEvent(RECOVERY_DAY_FOCUS_EVENT, { detail: day }))
}
