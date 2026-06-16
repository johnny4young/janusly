/**
 * Recovery-queue view state for the DLQ / recovery panel. Owns the operator
 * filters (status / owner / severity), the sort selection, their localStorage
 * persistence, the server-driven `/dlq` fetch, and inline recovery-overlay
 * hydration. Extracted from `DeadLettersPanel` so the
 * view-state machinery is independently testable and the panel can focus on
 * rendering / selection / dialogs.
 *
 * Used by:
 * - `apps/web/src/components/DeadLettersPanel.tsx`
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { RecoveryItemBadgeData } from '../components/RecoveryItemBadge'
import type { RecoveryItemDrawerData } from '../components/RecoveryItemDrawer'
import type { DeadLetter } from '../components/DeadLettersPanel'

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
}

/** Read + coercion-validate the persisted filters, falling back to the
 *  defaults (`open` / `all` / `all` / `newest`) on missing / unavailable /
 *  corrupt storage. Defensive about `window.localStorage` (private mode, SSR,
 *  jsdom) mirroring `auth.ts`. */
function readPersistedFilters(): PersistedFilters {
  const fallback: PersistedFilters = { status: 'open', ownerScope: 'all', severityFilter: 'all', sortKey: 'newest' }
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
  /** The cap-correct recovery-queue page from the server — already filtered by
   *  status ∩ owner ∩ severity and ordered by `sortKey` BEFORE the 200-row
   *  cap, so a matching row surfaces regardless of its `createdAt`. */
  filtered: DeadLetter[]
  /** True while the `/dlq` fetch is in flight — callers suppress the empty
   *  state to avoid a false flash before the first page lands. */
  recoveryFilterLoading: boolean
  /** Overlay map keyed by `deadLetterId` for the per-row recovery badge. */
  recoveryByDeadLetterId: Map<string, RecoveryOverlayItem>
  /** Overlay list, for the drawer's open-by-item-id lookup. */
  recoveryItems: RecoveryOverlayItem[]
  /** Manually refetch the current server-side recovery-queue page. */
  refresh: () => void
}

/**
 * Own the recovery-queue's filter/sort state AND its data fetch. The persisted
 * view selections restore on mount and write back on change; the `/dlq` fetch
 * re-runs on any filter/sort change + `platformVersion` bump and asks the
 * server to filter + sort BEFORE the 200-row cap (so a P1 older than the newest
 * 200 still surfaces). Each row carries its recovery overlay inline, so there's
 * one cap-correct source — no separate `/recovery/items` fetch.
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
  const [rows, setRows] = useState<DeadLetter[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1)
  }, [])

  // Server-side filter + sort, cap-correct: the query narrows + orders before
  // the 200-row limit. `owner=me` is resolved to `auth.userId` server-side.
  // Re-runs on any filter/sort change so the page always matches the controls.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (status !== 'all') params.set('status', status)
    if (ownerScope === 'mine') params.set('owner', 'me')
    if (severityFilter !== 'all') params.set('severity', severityFilter)
    params.set('sort', sortKey)
    params.set('limit', '200')
    api(`/dlq?${params.toString()}`)
      .then((resp) => {
        if (cancelled) return
        setRows(Array.isArray(resp) ? (resp as DeadLetter[]) : [])
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setRows([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion, refreshNonce, status, ownerScope, severityFilter, sortKey])

  // Persist the operator's filter + sort selections so they survive navigation
  // away from the Runs view and a tab reload. Mirrors the localStorage
  // posture used for the active org / locale; the no-op write on mount is
  // harmless.
  useEffect(() => {
    writePersistedFilters({ status, ownerScope, severityFilter, sortKey })
  }, [status, ownerScope, severityFilter, sortKey])

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
    ownerScope,
    setOwnerScope,
    severityFilter,
    setSeverityFilter,
    sortKey,
    setSortKey,
    filtered: rows,
    recoveryFilterLoading: loading,
    recoveryByDeadLetterId,
    recoveryItems,
    refresh,
  }
}
