/**
 * Flows-list view persistence (tag + folder + name search + sort + collapsed sections).
 *
 * The Flows dashboard's filters, name search, sort, and folder-collapse state are
 * inline state that reset on every visit — navigating away and back, or an F5
 * reload, drops them. These helpers persist the operator's view to `localStorage`
 * (a single per-browser key) so it's restored on the next mount.
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

/** The persisted Flows-list view: the selected tags (`[]` = all; multiple AND
 *  together), the selected folder (`''` = all), the name-search query, the sort,
 *  and the set of collapsed folder sections (folder names; the empty string `''`
 *  is the sentinel for the "Ungrouped" section, which a real folder name — min
 *  length 1 — can never collide with). */
export type FlowsFilters = {
  tags: string[]
  folder: string
  query: string
  sort: SortKey
  collapsedFolders: string[]
}

function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/** True for an object carrying at least the `{ query, sort }` pair — rejects a
 *  corrupt / outdated / partial localStorage value. `tags` / `folder` /
 *  `collapsedFolders` are read leniently in `readFlowsFilters` so a value written
 *  before any of them shipped (or with the legacy scalar `tag`) still restores
 *  the query / sort. */
function isFlowsFilters(value: unknown): value is FlowsFilters {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.query === 'string' && isSortKey(v.sort)
}

/** Read the saved Flows filters, or `null` when none / unavailable / corrupt.
 *  Safe to call during render (used as a lazy `useState` initializer). A stored
 *  value without `collapsedFolders` (written before folders shipped) still
 *  restores; its collapsed set defaults to empty. */
export function readFlowsFilters(): FlowsFilters | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isFlowsFilters(parsed)) return null
    const record = parsed as Record<string, unknown>
    const collapsedFolders = isStringArray(record.collapsedFolders)
      ? (record.collapsedFolders as string[])
      : []
    // `folder` is read leniently (default '' when absent) so a value written
    // before the folder filter shipped still restores the rest of the view.
    const folder = typeof record.folder === 'string' ? record.folder : ''
    // `tags` is read leniently WITH a migration from the legacy scalar `tag`
    // (written before the multi-tag filter): a non-empty `tag` becomes `[tag]`.
    const tags = isStringArray(record.tags)
      ? (record.tags as string[])
      : typeof record.tag === 'string' && record.tag.length > 0
        ? [record.tag]
        : []
    return { tags, folder, query: parsed.query, sort: parsed.sort, collapsedFolders }
  } catch {
    return null
  }
}

/** Persist the Flows filters; failure is non-fatal (storage unavailable /
 *  private mode / quota). Only the closed `{ tags, folder, query, sort,
 *  collapsedFolders }` shape is stored. */
export function writeFlowsFilters(filters: FlowsFilters): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        tags: filters.tags,
        folder: filters.folder,
        query: filters.query,
        sort: filters.sort,
        collapsedFolders: filters.collapsedFolders,
      }),
    )
  } catch {
    /* swallow — storage may be unavailable (private mode / quota). */
  }
}
