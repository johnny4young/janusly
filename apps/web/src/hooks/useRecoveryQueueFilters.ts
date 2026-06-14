/**
 * Recovery-queue filter state for the DLQ / recovery panel. Owns the three
 * operator filters (status / owner / severity), their localStorage
 * persistence, the recovery-items overlay fetch + its scope race-guard, and
 * the derived visible-rows set. Extracted from `DeadLettersPanel` so the
 * filter machinery is independently testable and the panel can focus on
 * rendering / selection / dialogs.
 *
 * Used by:
 * - `apps/web/src/components/DeadLettersPanel.tsx`
 */

import { useEffect, useMemo, useState } from 'react'
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
 *  severity (a client-side refinement of the already-loaded set — severity is
 *  present on every item the overlay fetch returns). */
export type SeverityFilter = 'all' | typeof SEVERITIES[number]

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

/** Coerce an arbitrary value into an `OwnerScope`, defaulting to `'all'`. */
function toOwnerScope(value: string): OwnerScope {
  return value === 'mine' ? 'mine' : 'all'
}

/** localStorage key holding the operator's recovery-queue filter selections.
 *  Single global UI-pref blob, matching the `janusly:` prefix convention used
 *  for the active org / locale. */
const FILTERS_STORAGE_KEY = 'janusly:recoveryQueueFilters'

/** The persisted recovery-queue filter selections. Every field is replayed
 *  through its coercion guard on read, so a stale or malformed stored value
 *  degrades to the default rather than corrupting the panel state. */
type PersistedFilters = {
  status: DeadLetterStatusFilter
  ownerScope: OwnerScope
  severityFilter: SeverityFilter
}

/** Read + coercion-validate the persisted filters, falling back to the
 *  defaults (`open` / `all` / `all`) on missing / unavailable / corrupt
 *  storage. Defensive about `window.localStorage` (private mode, SSR, jsdom)
 *  mirroring `auth.ts`. */
function readPersistedFilters(): PersistedFilters {
  const fallback: PersistedFilters = { status: 'open', ownerScope: 'all', severityFilter: 'all' }
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
    }
  } catch {
    return fallback
  }
}

/** Persist the current filter selections; non-fatal when storage is
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

/** A recovery-item overlay row: the badge + drawer shapes merged, as the
 *  panel hydrates each `/recovery/items` entry. */
type RecoveryOverlayItem = RecoveryItemBadgeData & RecoveryItemDrawerData

/** Everything the recovery queue needs to render its filter controls, the
 *  filtered DLQ rows, and the recovery-item overlay (badges + drawer). */
export type RecoveryQueueFilters = {
  status: DeadLetterStatusFilter
  setStatus: (value: DeadLetterStatusFilter) => void
  ownerScope: OwnerScope
  setOwnerScope: (value: OwnerScope) => void
  severityFilter: SeverityFilter
  setSeverityFilter: (value: SeverityFilter) => void
  /** Visible DLQ rows after the status ∩ owner ∩ severity narrowing. */
  filtered: DeadLetter[]
  /** True while the owner=me / severity overlay fetch is in flight for the
   *  current scope — callers suppress the empty state to avoid a false flash. */
  recoveryFilterLoading: boolean
  /** Overlay map keyed by `deadLetterId` for the per-row recovery badge. */
  recoveryByDeadLetterId: Map<string, RecoveryOverlayItem>
  /** Overlay list, for the drawer's open-by-item-id lookup. */
  recoveryItems: RecoveryOverlayItem[]
}

/**
 * Manage the recovery-queue filters + the recovery-item overlay for a given
 * `deadLetters` list. The persisted filter selections restore on mount and
 * write back on change; the overlay fetch re-runs on `platformVersion` bumps
 * and owner-scope changes, with a readiness guard so a slow fetch never
 * filters against (or flashes an empty state over) a stale overlay.
 */
export function useRecoveryQueueFilters(deadLetters: DeadLetter[]): RecoveryQueueFilters {
  // Filter selections persist across navigation + reload (localStorage).
  // Read once on mount; each field is coercion-validated so stale/corrupt
  // storage falls back to the defaults rather than breaking the panel.
  const [initialFilters] = useState(readPersistedFilters)
  const [status, setStatus] = useState<DeadLetterStatusFilter>(initialFilters.status)
  const [ownerScope, setOwnerScope] = useState<OwnerScope>(initialFilters.ownerScope)
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>(initialFilters.severityFilter)
  const [recoveryItems, setRecoveryItems] = useState<RecoveryOverlayItem[]>([])
  const [recoveryItemsScope, setRecoveryItemsScope] = useState<OwnerScope | null>(null)
  const platformVersion = useWorkflowStore((s) => s.platformVersion)

  useEffect(() => {
    let cancelled = false
    const scope = ownerScope
    setRecoveryItemsScope(null)
    // Scope the overlay fetch to the operator's own incidents when "Mine"
    // is active. `owner=me` is resolved to `auth.userId` server-side, and the
    // server-side scope is correct under the 200-row cap (client-side
    // filtering of an all-items page could miss mine beyond the cap).
    api(`/recovery/items?limit=200${ownerScope === 'mine' ? '&owner=me' : ''}`)
      .then((resp: { items?: Array<{
        id: string
        deadLetterId: string
        owner: string | null
        severity: 'p1' | 'p2' | 'p3' | 'p4'
        status: string
        slaTargetAt: string
        resolutionReason: string | null
        comments: Array<{ id: string; authorUserId: string; body: string; createdAt: string }>
        workflowId?: string | null
        occurrenceCount?: number
        lastOccurredAt?: string
      }> }) => {
        if (cancelled) return
        const hydrated = (resp?.items ?? []).map((it) => ({
          id: it.id,
          deadLetterId: it.deadLetterId,
          owner: it.owner,
          severity: it.severity,
          status: it.status as RecoveryItemBadgeData['status'],
          slaTargetAtIso: it.slaTargetAt,
          resolutionReason: (it.resolutionReason as RecoveryItemDrawerData['resolutionReason']) ?? null,
          comments: it.comments ?? [],
          workflowId: it.workflowId ?? null,
          occurrenceCount: it.occurrenceCount ?? 1,
          lastOccurredAtIso: it.lastOccurredAt ?? it.slaTargetAt,
        }))
        setRecoveryItems(hydrated)
        setRecoveryItemsScope(scope)
      })
      .catch(() => {
        if (!cancelled) {
          setRecoveryItems([])
          setRecoveryItemsScope(scope)
        }
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion, ownerScope])

  // Persist the operator's filter selections so they survive navigation
  // away from the Runs view and a tab reload. Mirrors the localStorage
  // posture used for the active org / locale; the no-op write on mount is
  // harmless.
  useEffect(() => {
    writePersistedFilters({ status, ownerScope, severityFilter })
  }, [status, ownerScope, severityFilter])

  const recoveryItemsReadyForCurrentScope = recoveryItemsScope === ownerScope
  const recoveryByDeadLetterId = useMemo(() => {
    const map = new Map<string, RecoveryOverlayItem>()
    for (const it of recoveryItems) map.set(it.deadLetterId, it)
    return map
  }, [recoveryItems])

  const filtered = useMemo(() => {
    let rows = status === 'all' ? deadLetters : deadLetters.filter(item => item.status === status)
    // "Mine" narrows to dead letters whose recovery item is owned by the
    // current operator. The overlay map is already scoped to owner=me by the
    // fetch above, so membership in it is the ownership test; a dead letter
    // with no recovery item is unassigned and correctly hidden under "Mine".
    if (ownerScope === 'mine') {
      if (!recoveryItemsReadyForCurrentScope) return []
      rows = rows.filter(item => recoveryByDeadLetterId.has(item.id))
    }
    // Severity narrows to dead letters whose recovery item carries the
    // selected severity. Client-side over the already-loaded overlay (every
    // item ships its severity); a dead letter with no recovery item has no
    // severity to match and is correctly excluded once a severity is picked.
    if (severityFilter !== 'all') {
      if (!recoveryItemsReadyForCurrentScope) return []
      rows = rows.filter(item => recoveryByDeadLetterId.get(item.id)?.severity === severityFilter)
    }
    return rows
  }, [deadLetters, status, ownerScope, recoveryItemsReadyForCurrentScope, recoveryByDeadLetterId, severityFilter])
  const recoveryFilterLoading = (ownerScope === 'mine' || severityFilter !== 'all') && !recoveryItemsReadyForCurrentScope

  return {
    status,
    setStatus,
    ownerScope,
    setOwnerScope,
    severityFilter,
    setSeverityFilter,
    filtered,
    recoveryFilterLoading,
    recoveryByDeadLetterId,
    recoveryItems,
  }
}
