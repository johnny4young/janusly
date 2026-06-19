/**
 * Flows-list filter persistence (tag + name search + sort).
 *
 * The Flows dashboard's tag filter, name search, and sort are inline state that
 * reset on every visit — navigating away and back, or an F5 reload, drops them.
 * These helpers persist the operator's view to `localStorage` (a single
 * per-browser key) so it's restored on the next mount.
 *
 * Defensive in the same way as the canvas-viewport / locale / theme helpers:
 * every access is guarded (storage may be absent in non-browser/test contexts,
 * or throw in private mode / on quota) and a corrupt or wrong-shaped value
 * degrades to null → the dashboard falls back to defaults.
 *
 * Used by `apps/web/src/components/WorkflowsDashboard.tsx`.
 */

const KEY = 'janusly:flowsFilters'

/** Sort options for the Flows list — exported so the dashboard's `sort` state
 *  and the persisted-value validator agree on the closed set. */
export const SORT_KEYS = ['recent', 'name', 'failed'] as const
export type SortKey = (typeof SORT_KEYS)[number]

/** The persisted Flows-list view: the selected tag (`''` = all), the name-search
 *  query, and the sort. */
export type FlowsFilters = {
  tag: string
  query: string
  sort: SortKey
}

function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value)
}

/** True only for a fully-shaped `{ tag, query, sort }` object — rejects a
 *  corrupt / outdated / partial localStorage value. */
function isFlowsFilters(value: unknown): value is FlowsFilters {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.tag === 'string' && typeof v.query === 'string' && isSortKey(v.sort)
}

/** Read the saved Flows filters, or `null` when none / unavailable / corrupt.
 *  Safe to call during render (used as a lazy `useState` initializer). */
export function readFlowsFilters(): FlowsFilters | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isFlowsFilters(parsed) ? { tag: parsed.tag, query: parsed.query, sort: parsed.sort } : null
  } catch {
    return null
  }
}

/** Persist the Flows filters; failure is non-fatal (storage unavailable /
 *  private mode / quota). Only the `{ tag, query, sort }` triple is stored. */
export function writeFlowsFilters(filters: FlowsFilters): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ tag: filters.tag, query: filters.query, sort: filters.sort }),
    )
  } catch {
    /* swallow — storage may be unavailable (private mode / quota). */
  }
}
