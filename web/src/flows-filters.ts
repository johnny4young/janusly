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
 * Used by `web/src/components/WorkflowsDashboard.tsx`.
 */

import { isStringArray } from './lib/guards'

const KEY = 'janusly:flowsFilters'

/** Sortable Flows-table columns — exported so the dashboard's `sort` state and
 *  the persisted-value validator agree on the closed set. */
export const SORT_KEYS = ['name', 'status', 'openFailures', 'health', 'lastRun', 'version'] as const
export type SortKey = (typeof SORT_KEYS)[number]
type SortDirection = 'asc' | 'desc'
export type FlowsSort = { key: SortKey; direction: SortDirection }

/** First-click direction per column: the end of the range an operator is after. */
const SORT_FIRST_DIRECTION: Record<SortKey, SortDirection> = {
  name: 'asc', status: 'asc', openFailures: 'desc', health: 'asc', lastRun: 'desc', version: 'desc',
}

export const DEFAULT_FLOWS_SORT: FlowsSort = { key: 'lastRun', direction: 'desc' }

/** The Recent / Name / Failed first switch stored these values. */
const LEGACY_SORTS: ReadonlyMap<unknown, SortKey> = new Map([['recent', 'lastRun'], ['failed', 'status']])

export function nextFlowsSort(current: FlowsSort, key: SortKey): FlowsSort {
  if (current.key !== key) return { key, direction: SORT_FIRST_DIRECTION[key] }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}

/** The persisted Flows-list view: the selected tags (`[]` = all; multiple AND
 *  together), the selected folder (`''` = all), the name-search query, the sort,
 *  and the set of collapsed folder sections (folder names; the empty string `''`
 *  is the sentinel for the "Ungrouped" section, which a real folder name — min
 *  length 1 — can never collide with). */
export type FlowsFilters = {
  tags: string[]
  folder: string
  query: string
  sort: FlowsSort
  collapsedFolders: string[]
}

function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value)
}

function readSort(record: Record<string, unknown>): FlowsSort | null {
  const { sortDirection } = record
  const sort = LEGACY_SORTS.get(record.sort) ?? record.sort
  if (!isSortKey(sort)) return null
  const direction = sortDirection === 'asc' || sortDirection === 'desc' ? sortDirection : SORT_FIRST_DIRECTION[sort]
  return { key: sort, direction }
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
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    // A corrupt or partial value must carry at least a query and a sort; the
    // other fields are read leniently so older stored views still restore.
    const sort = readSort(record)
    if (typeof record.query !== 'string' || !sort) return null
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
    return { tags, folder, query: record.query, sort, collapsedFolders }
  } catch {
    return null
  }
}

/** Persist the Flows filters; failure is non-fatal (storage unavailable /
 *  private mode / quota). Only the closed `{ tags, folder, query, sort,
 *  sortDirection, collapsedFolders }` shape is stored. */
export function writeFlowsFilters(filters: FlowsFilters): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        tags: filters.tags,
        folder: filters.folder,
        query: filters.query,
        sort: filters.sort.key,
        sortDirection: filters.sort.direction,
        collapsedFolders: filters.collapsedFolders,
      }),
    )
  } catch {
    /* swallow — storage may be unavailable (private mode / quota). */
  }
}
