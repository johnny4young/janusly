/**
 * Recovery-queue view state for the DLQ / recovery panel. Owns the operator
 * filters (status / owner / severity), the sort selection, their localStorage
 * persistence, the server-driven `/dlq` fetch, and inline recovery-overlay
 * hydration. Extracted from `DeadLettersPanel` so the
 * view-state machinery is independently testable and the panel can focus on
 * rendering / selection / dialogs.
 *
 * Used by:
 * - `web/src/components/DeadLettersPanel.tsx`
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import {
  acknowledgeRecoveryFocusDay,
  consumeRecoveryFocusDay,
  RECOVERY_DAY_FOCUS_EVENT,
} from '../components/recovery-day-focus-bus'
import type { RecoveryItemBadgeData } from '../components/RecoveryItemBadge'
import type { RecoveryItemDrawerData } from '../components/RecoveryItemDrawer'
import type { DeadLetter } from '../components/dead-letter-types'

/** DLQ-status filter values; `'all'` shows every status. */
export const statuses = ['all', 'open', 'replayed', 'resolved'] as const
export type DeadLetterStatusFilter = typeof statuses[number]
export const STATUS_FILTER_KEYS: Record<DeadLetterStatusFilter, string> = {
  all: 'dlq.filter.all',
  open: 'dlq.filter.open',
  replayed: 'dlq.filter.replayed',
  resolved: 'dlq.filter.resolved',
}

/** Owner-scope filter for the recovery queue. `'all'` shows the whole org
 *  queue; `'mine'` narrows to the dead letters whose recovery item is owned
 *  by the current operator (resolved server-side via `?owner=me`, which the
 *  membership resolver maps to `auth.userId`). */
export type OwnerScope = 'all' | 'mine'

/** The four closed recovery-item severities, highest-urgency first. Drives
 *  the severity filter's options; the labels reuse the `recoveryItems.severity.*`
 *  catalog the badge already renders. */
export const SEVERITIES = ['p1', 'p2', 'p3', 'p4'] as const
/** Severity-scope filter for the recovery queue. `'all'` shows every severity;
 *  a `p1`–`p4` value narrows to dead letters whose recovery item carries that
 *  severity. The hook sends the filter to `/dlq`, so the server applies it
 *  before the 200-row cap. */
export type SeverityFilter = 'all' | typeof SEVERITIES[number]

/** Sort keys for the recovery queue. `'newest'` (default) matches the server's
 *  `createdAt desc` order so it is a no-op; the rest let an operator triage by
 *  age, criticality, or SLA deadline. */
export const SORT_KEYS = ['newest', 'oldest', 'severity', 'sla'] as const
export type SortKey = typeof SORT_KEYS[number]
/** i18n catalog keys for each sort option's label. */
export const SORT_KEY_LABELS: Record<SortKey, string> = {
  newest: 'dlq.sort.newest',
  oldest: 'dlq.sort.oldest',
  severity: 'dlq.sort.severity',
  sla: 'dlq.sort.sla',
}

/** Coerce a `<select>` value into a `DeadLetterStatusFilter`, defaulting to `'open'`. */
export function toStatusFilter(value: string): DeadLetterStatusFilter {
  for (const status of statuses) {
    if (status === value) return status
  }
  return 'open'
}

/** Coerce a `<select>` value into a `SeverityFilter`, defaulting to `'all'`. */
export function toSeverityFilter(value: string): SeverityFilter {
  for (const sev of SEVERITIES) {
    if (sev === value) return sev
  }
  return 'all'
}

/** Coerce a `<select>` value into a `SortKey`, defaulting to `'newest'`. */
export function toSortKey(value: string): SortKey {
  for (const key of SORT_KEYS) {
    if (key === value) return key
  }
  return 'newest'
}

/** Coerce an arbitrary stored value into a bounded search term (≤100 chars, the
 *  server's cap). A non-string degrades to the empty term. */
function toSearchTerm(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 100) : ''
}

/** Coerce an arbitrary value into an `OwnerScope`, defaulting to `'all'`. */
function toOwnerScope(value: string): OwnerScope {
  return value === 'mine' ? 'mine' : 'all'
}

/** localStorage key holding the operator's recovery-queue filter + sort
 *  selections. Single global UI-pref blob, matching the `janusly:` prefix
 *  convention used for the active org / locale. */
const FILTERS_STORAGE_KEY = 'janusly:recoveryQueueFilters'

/** The persisted recovery-queue filter + sort selections. Every field is
 *  replayed through its coercion guard on read, so a stale or malformed
 *  stored value degrades to the default rather than corrupting the panel
 *  state. */
type PersistedFilters = {
  status: DeadLetterStatusFilter
  ownerScope: OwnerScope
  severityFilter: SeverityFilter
  sortKey: SortKey
  search: string
}

/** Read + coercion-validate the persisted filters, falling back to the
 *  defaults (`open` / `all` / `all` / `newest`) on missing / unavailable /
 *  corrupt storage. Defensive about `window.localStorage` (private mode, SSR,
 *  jsdom) mirroring `auth.ts`. */
function readPersistedFilters(): PersistedFilters {
  const fallback: PersistedFilters = { status: 'open', ownerScope: 'all', severityFilter: 'all', sortKey: 'newest', search: '' }
  const storage = getLocalStorage()
  if (!storage) return fallback
  try {
    const raw = storage.getItem(FILTERS_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      status: toStatusFilter(String(parsed.status ?? '')),
      ownerScope: toOwnerScope(String(parsed.ownerScope ?? '')),
      severityFilter: toSeverityFilter(String(parsed.severityFilter ?? '')),
      sortKey: toSortKey(String(parsed.sortKey ?? '')),
      search: toSearchTerm(parsed.search),
    }
  } catch {
    return fallback
  }
}

/** Persist the current filter + sort selections; non-fatal when storage is
 *  unavailable (private mode / quota), mirroring `auth.ts`. */
function writePersistedFilters(value: PersistedFilters): void {
  const storage = getLocalStorage()
  if (!storage) return
  try {
    storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Non-fatal — storage may be disabled or full.
  }
}

/** Best-effort storage accessor. Some browsers / privacy modes throw while
 *  reading `window.localStorage` itself, before `getItem` / `setItem` runs. */
function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/** A recovery-item overlay row: the badge + drawer shapes merged, hydrated
 *  from each recovery-queue row's inline `recovery` field. */
type RecoveryOverlayItem = RecoveryItemBadgeData & RecoveryItemDrawerData

/** Rows fetched per "load more" page. The server clamps to its own max, so this
 *  is just the request size; smaller pages keep the first paint snappy. */
const RECOVERY_QUEUE_PAGE_SIZE = 50

/** The keyset page envelope returned by `GET /dlq/queue`: the rows for this
 *  page, the opaque cursor for the next page (`null` at the end), and whether a
 *  next page exists. */
type RecoveryQueuePageResponse = {
  items: DeadLetter[]
  nextCursor: string | null
  hasMore: boolean
}

/** The org-wide DLQ status breakdown returned by `GET /dlq/counts` — the
 *  mini-grid's queue-health summary, independent of the filtered/paginated page. */
type RecoveryQueueCounts = {
  total: number
  open: number
  replayed: number
  resolved: number
}
const EMPTY_COUNTS: RecoveryQueueCounts = { total: 0, open: 0, replayed: 0, resolved: 0 }

/** Build the `/dlq/queue?…` path from the current filter/sort selections plus an
 *  optional keyset `cursor`. Shared by the first-page effect and `loadMore` so
 *  the next-page request is byte-identical to the first except for the cursor. */
function buildQueuePath(args: {
  status: DeadLetterStatusFilter
  ownerScope: OwnerScope
  severityFilter: SeverityFilter
  sortKey: SortKey
  search: string
  day: string | null
  cursor: string | null
}): string {
  const params = new URLSearchParams()
  if (args.status !== 'all') params.set('status', args.status)
  if (args.ownerScope === 'mine') params.set('owner', 'me')
  if (args.severityFilter !== 'all') params.set('severity', args.severityFilter)
  if (args.search) params.set('search', args.search)
  if (args.day) params.set('day', args.day)
  params.set('sort', args.sortKey)
  params.set('limit', String(RECOVERY_QUEUE_PAGE_SIZE))
  if (args.cursor) params.set('cursor', args.cursor)
  return `/dlq/queue?${params.toString()}`
}

/** Everything the recovery queue needs to render its filter/sort controls, the
 *  filtered + ordered DLQ rows, and the recovery-item overlay (badges +
 *  drawer). */
export type RecoveryQueueFilters = {
  status: DeadLetterStatusFilter
  setStatus: (value: DeadLetterStatusFilter) => void
  ownerScope: OwnerScope
  setOwnerScope: (value: OwnerScope) => void
  severityFilter: SeverityFilter
  setSeverityFilter: (value: SeverityFilter) => void
  sortKey: SortKey
  setSortKey: (value: SortKey) => void
  /** Raw (un-debounced) value of the search box — bind the `<input>` to this.
   *  Its debounced mirror drives the server fetch (substring over node id / run
   *  id / error message), so typing doesn't issue a request per keystroke. */
  searchInput: string
  setSearchInput: (value: string) => void
  /** Active heatmap drill-in day (`YYYY-MM-DD`) or null. When set, the queue is
   *  restricted to failures created that UTC day; the panel shows a clear chip. */
  dayFilter: string | null
  /** Clear the day drill-in and refetch the unfiltered queue. */
  clearDayFilter: () => void
  /** The recovery-queue rows loaded so far — the first keyset page plus any
   *  appended via {@link loadMore}. Server-filtered by status ∩ owner ∩ severity
   *  and ordered by `sortKey` before the page cap, so a matching row surfaces
   *  regardless of its `createdAt`. */
  filtered: DeadLetter[]
  /** True while the FIRST-page fetch is in flight — callers suppress the empty
   *  state to avoid a false flash before the first page lands. (A "load more"
   *  fetch sets {@link loadingMore} instead, so it never blanks the list.) */
  recoveryFilterLoading: boolean
  /** Overlay map keyed by `deadLetterId` for the per-row recovery badge. */
  recoveryByDeadLetterId: Map<string, RecoveryOverlayItem>
  /** Overlay list, for the drawer's open-by-item-id lookup. */
  recoveryItems: RecoveryOverlayItem[]
  /** Manually refetch the queue from page 1 (resets pagination). */
  refresh: () => void
  /** Fetch the next keyset page and APPEND it to {@link filtered}. No-op when
   *  there is no next page or a load-more is already in flight. */
  loadMore: () => void
  /** Whether the server reported a next page after the most recent fetch. */
  hasMore: boolean
  /** True while a {@link loadMore} fetch is in flight (drives the button's
   *  disabled / "loading" state without blanking the already-loaded rows). */
  loadingMore: boolean
  /** Org-wide DLQ status breakdown for the mini-grid — total / open / replayed /
   *  resolved across the WHOLE queue, NOT the filtered page. Refetched on
   *  `platformVersion` / refresh only, never on a filter or sort change. */
  counts: RecoveryQueueCounts
}

/**
 * Own the recovery-queue's filter/sort state AND its data fetch. The persisted
 * view selections restore on mount and write back on change; the `/dlq/queue`
 * fetch re-runs on any filter/sort change + `platformVersion` bump and asks the
 * server to filter + sort BEFORE the page cap (so a P1 older than the newest
 * page still surfaces). Each row carries its recovery overlay inline, so there's
 * one cap-correct source — no separate `/recovery/items` fetch. Paging is
 * keyset ("load more"): {@link loadMore} appends the next page; any filter/sort
 * change resets to page 1.
 */
export function useRecoveryQueueFilters(): RecoveryQueueFilters {
  // Filter + sort selections persist across navigation + reload (localStorage).
  // Read once on mount; each field is coercion-validated so stale/corrupt
  // storage falls back to the defaults rather than breaking the panel.
  const [initialFilters] = useState(readPersistedFilters)
  const [status, setStatus] = useState<DeadLetterStatusFilter>(initialFilters.status)
  const [ownerScope, setOwnerScope] = useState<OwnerScope>(initialFilters.ownerScope)
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>(initialFilters.severityFilter)
  const [sortKey, setSortKey] = useState<SortKey>(initialFilters.sortKey)
  // Raw search box value vs the debounced term that drives the server fetch.
  // Both seed from the persisted term so the first load already carries it.
  const [searchInput, setSearchInput] = useState<string>(initialFilters.search)
  const [search, setSearch] = useState<string>(initialFilters.search)
  // Heatmap drill-in: a `YYYY-MM-DD` restricting the queue to one UTC day. Not
  // persisted (a transient, click-scoped focus). A committed mount adopts the
  // pending handoff below; never consume sessionStorage during render because
  // React may discard a speculative render before the queue reaches the DOM.
  const [dayFilter, setDayFilter] = useState<string | null>(null)
  const [rows, setRows] = useState<DeadLetter[]>([])
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [counts, setCounts] = useState<RecoveryQueueCounts>(EMPTY_COUNTS)
  const [refreshNonce, setRefreshNonce] = useState(0)
  // Bumped on every first-page fetch; `loadMore` captures it and drops a stale
  // append if a filter/sort/refresh landed mid-fetch (the page-1 reset wins).
  const requestEpochRef = useRef(0)
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1)
  }, [])
  const clearDayFilter = useCallback(() => setDayFilter(null), [])

  // A heatmap cell click on Home dispatches the focus event; adopt the day when
  // the queue is already mounted and consume the stashed handoff only after a
  // real mount. Register first so a request cannot fall into a gap between the
  // storage read and listener setup.
  useEffect(() => {
    const onFocus = (event: Event) => {
      const day = (event as CustomEvent<unknown>).detail
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return
      setDayFilter(day)
    }
    window.addEventListener(RECOVERY_DAY_FOCUS_EVENT, onFocus)
    const pendingDay = consumeRecoveryFocusDay()
    if (pendingDay) setDayFilter(pendingDay)
    return () => window.removeEventListener(RECOVERY_DAY_FOCUS_EVENT, onFocus)
  }, [])

  useEffect(() => {
    if (dayFilter) acknowledgeRecoveryFocusDay(dayFilter)
  }, [dayFilter])

  // Server-side filter + sort, cap-correct: the query narrows + orders before
  // the page cap. `owner=me` is resolved to `auth.userId` server-side. Re-runs
  // on any filter/sort/refresh change, which RESETS pagination to page 1.
  useEffect(() => {
    let cancelled = false
    requestEpochRef.current += 1
    setLoading(true)
    api(buildQueuePath({ status, ownerScope, severityFilter, sortKey, search, day: dayFilter, cursor: null }))
      .then((resp) => {
        if (cancelled) return
        const page = resp as RecoveryQueuePageResponse
        setRows(Array.isArray(page?.items) ? page.items : [])
        setCursor(page?.nextCursor ?? null)
        setHasMore(Boolean(page?.hasMore))
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setRows([])
        setCursor(null)
        setHasMore(false)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion, refreshNonce, status, ownerScope, severityFilter, sortKey, search, dayFilter])

  // Org-wide status counts for the mini-grid. Keyed ONLY on platformVersion +
  // refresh — NOT on the filter/sort, because the mini-grid summarizes the WHOLE
  // queue, not the filtered page. A failed fetch degrades to zeros.
  useEffect(() => {
    let cancelled = false
    api('/dlq/counts')
      .then((resp) => {
        if (cancelled) return
        const c = resp as Partial<RecoveryQueueCounts> | null
        setCounts({
          total: Number(c?.total) || 0,
          open: Number(c?.open) || 0,
          replayed: Number(c?.replayed) || 0,
          resolved: Number(c?.resolved) || 0,
        })
      })
      .catch(() => {
        if (cancelled) return
        setCounts(EMPTY_COUNTS)
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion, refreshNonce])

  // Fetch the next keyset page and APPEND it. The epoch guard drops the result
  // if a filter/sort/refresh reset the queue mid-fetch (so stale rows never
  // graft onto the new page-1); the button always re-enables in `finally`.
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return
    const epoch = requestEpochRef.current
    setLoadingMore(true)
    try {
      const page = (await api(
        buildQueuePath({ status, ownerScope, severityFilter, sortKey, search, day: dayFilter, cursor }),
      )) as RecoveryQueuePageResponse
      if (epoch !== requestEpochRef.current) return
      setRows((prev) => [...prev, ...(Array.isArray(page?.items) ? page.items : [])])
      setCursor(page?.nextCursor ?? null)
      setHasMore(Boolean(page?.hasMore))
    } catch {
      if (epoch === requestEpochRef.current) setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }, [cursor, loadingMore, status, ownerScope, severityFilter, sortKey, search, dayFilter])

  // Settle `searchInput` into the debounced `search` ~300ms after the last
  // keystroke so typing doesn't fire a request per character (mirrors the
  // Flows-list search debounce). The fetch effect keys off `search`, so a
  // settled change resets pagination to page 1. The term is trimmed + capped to
  // the server's ≤100 bound here so the persisted + sent value is normalized.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim().slice(0, 100)), 300)
    return () => clearTimeout(id)
  }, [searchInput])

  // Persist the operator's filter + sort + search selections so they survive
  // navigation away from the Runs view and a tab reload. Mirrors the
  // localStorage posture used for the active org / locale; the no-op write on
  // mount is harmless. Persists the debounced `search` (trimmed/capped).
  useEffect(() => {
    writePersistedFilters({ status, ownerScope, severityFilter, sortKey, search })
  }, [status, ownerScope, severityFilter, sortKey, search])

  // Hydrate the recovery overlay from each row's inline `recovery` field — one
  // cap-correct source, no second fetch. Rows with no recovery item (e.g. a
  // legacy tenant with auto-create off) simply contribute no overlay entry.
  const recoveryItems = useMemo<RecoveryOverlayItem[]>(() => {
    const out: RecoveryOverlayItem[] = []
    for (const row of rows) {
      const r = row.recovery
      if (!r) continue
      out.push({
        id: r.id,
        deadLetterId: row.id,
        owner: r.owner,
        severity: r.severity,
        status: r.status as RecoveryItemBadgeData['status'],
        slaTargetAtIso: r.slaTargetAt,
        resolutionReason: (r.resolutionReason as RecoveryItemDrawerData['resolutionReason']) ?? null,
        comments: r.comments ?? [],
        workflowId: r.workflowId ?? null,
        metadataWorkflowId: r.metadataWorkflowId ?? null,
        occurrenceCount: r.occurrenceCount ?? 1,
        lastOccurredAtIso: r.lastOccurredAt ?? r.slaTargetAt,
      })
    }
    return out
  }, [rows])

  const recoveryByDeadLetterId = useMemo(() => {
    const map = new Map<string, RecoveryOverlayItem>()
    for (const it of recoveryItems) map.set(it.deadLetterId, it)
    return map
  }, [recoveryItems])

  return {
    status,
    setStatus,
    dayFilter,
    clearDayFilter,
    ownerScope,
    setOwnerScope,
    severityFilter,
    setSeverityFilter,
    sortKey,
    setSortKey,
    searchInput,
    setSearchInput,
    filtered: rows,
    recoveryFilterLoading: loading,
    recoveryByDeadLetterId,
    recoveryItems,
    refresh,
    loadMore,
    hasMore,
    loadingMore,
    counts,
  }
}
