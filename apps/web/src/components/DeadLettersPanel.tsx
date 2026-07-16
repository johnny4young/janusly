/**
 * Dead-letter operations panel — surfaces `dead_letters` rows with replay
 * + resolve actions. Calls `bumpPlatformVersion()` after a successful
 * replay so the Runs panel re-fetches and the row's status flips.
 *
 * Used by `RightPanel.tsx` (`runs` tab → Operations card).
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CircleCheck, Copy, Download, FlaskConical, GitCompare, Inbox, RefreshCw, Sparkles, X } from 'lucide-react'

import { downtimeSeverity, humanizeAge } from './recovery-center/helpers'
import { api, downloadFromApi } from '../api'
import { formatStatusLabel } from '../constants'
import { useWorkflowStore } from '../store'
import { WorkflowDiffView } from './WorkflowDiffView'
import type { WorkflowDefinition } from '../types'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { FailureClustersCard } from './FailureClustersCard'
import { AutoHealingPendingCard } from './AutoHealingPendingCard'
// Modal-only + heavy (~1.2k lines) — load on first open, not in the main chunk.
const RecoveryDialog = lazy(() => import('./RecoveryDialog').then((m) => ({ default: m.RecoveryDialog })))
import { ReplayLabDialog } from './ReplayLabDialog'
import { RecoveryItemBadge } from './RecoveryItemBadge'
import { RecoveryItemDrawer } from './RecoveryItemDrawer'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useVirtualList } from '../hooks/useVirtualList'
import { isKeyboardShortcutTypingTarget } from '../keyboard-shortcut-target'
import { copyText } from '../clipboard'
import { buildRecoveryErrorSummary } from '../recovery-error-summary'
import {
  SEVERITIES,
  SORT_KEYS,
  SORT_KEY_LABELS,
  STATUS_FILTER_KEYS,
  statuses,
  toSeverityFilter,
  toSortKey,
  toStatusFilter,
  useRecoveryQueueFilters,
} from '../hooks/useRecoveryQueueFilters'
import {
  consumeRecoveryQueueFocus,
  parseRecoveryQueueFocusEvent,
  RECOVERY_QUEUE_FOCUS_EVENT,
  type RecoveryQueueFocusRequest,
} from './recovery-queue-focus-bus'
import { requestRecoveryAllClearIfQueueEmpty } from './recovery-all-clear-coordinator'

/** Fixed DLQ row height (54px) plus the 6px `.we-list` gap. The matching
 *  `.we-dlq-row` rule prevents metadata wrapping so virtual offsets stay
 *  exact even when the queue is long. */
const DLQ_ROW_PITCH = 60

/** The recovery-item overlay the API folds inline onto each recovery-queue
 *  row, so the panel renders the badge/drawer from one cap-correct fetch. */
export type DeadLetterRecovery = {
  id: string
  owner: string | null
  severity: 'p1' | 'p2' | 'p3' | 'p4'
  status: string
  slaTargetAt: string
  resolutionReason: string | null
  comments: Array<{ id: string; authorUserId: string; body: string; createdAt: string }>
  /** Source workflow id from the run payload; may be an unsaved demo/template id. */
  workflowId?: string | null
  /** Persisted workflow id eligible for metadata lookups; null for unsaved templates. */
  metadataWorkflowId?: string | null
  occurrenceCount?: number
  lastOccurredAt?: string
}

/** Change-correlation envelope from the `/dlq?id=` detail read: the
 *  failing run executed `version`, saved within the suspect window before the
 *  failure; both DAG snapshots ride along so the diff renders with no extra
 *  fetch. Copy stays temporal ("started after ... was saved"), never causal. */
export type SuspectVersionInfo = {
  workflowId: string
  version: number
  versionId: string
  savedAt: string
  previousVersion: number
  previousVersionId: string
  dagJson: WorkflowDefinition
  previousDagJson: WorkflowDefinition
}

/** Web-side `dead_letters` row shape (matches the API's response). `recovery`
 *  is the inline overlay (null when the row has no paired recovery item).
 *  LIST rows (`/dlq`, `/dlq/queue`) are summary projections: they carry
 *  `nodeType` / `workflowName` but NOT `workflowJson` / `nodeJson` — those
 *  unbounded snapshots only come back from the `/dlq?id=` detail read, which
 *  the panel fetches on selection / before opening the Recovery dialog. */
export type DeadLetter = {
  id: string
  runId: string
  nodeId: string
  attempt: number
  status: 'open' | 'replayed' | 'resolved' | string
  /** Full workflow snapshot — detail reads only; absent on list rows. */
  workflowJson?: unknown
  /** Full node JSON — detail reads only; absent on list rows. */
  nodeJson?: unknown
  errorJson: unknown
  /** `node_json->>'type'` summary projection (list rows). */
  nodeType?: string | null
  /** `workflow_json->>'name'` summary projection (list rows). */
  workflowName?: string | null
  createdAt?: string
  replayedAt?: string
  recovery?: DeadLetterRecovery | null
  /** Suspect-version correlation — detail reads only; null when no recent-save correlation. */
  suspectVersion?: SuspectVersionInfo | null
}

type BulkResolveResult = {
  resolved: number
  failed: number
  errors: Array<{ deadLetterId: string; error: string }>
}

function isBulkResolveResult(value: unknown): value is BulkResolveResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BulkResolveResult>
  return typeof candidate.resolved === 'number'
    && typeof candidate.failed === 'number'
    && Array.isArray(candidate.errors)
}

/** Partial-success envelope returned by POST /dlq/bulk-replay (sibling of
 *  BulkResolveResult, but counts replayed rows rather than resolved ones). */
type BulkReplayResult = {
  replayed: number
  failed: number
  errors: Array<{ deadLetterId: string; error: string }>
}

function isBulkReplayResult(value: unknown): value is BulkReplayResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BulkReplayResult>
  return typeof candidate.replayed === 'number'
    && typeof candidate.failed === 'number'
    && Array.isArray(candidate.errors)
}

/** How many per-row failure reasons to list inline before collapsing to "+N more". */
const BULK_ERROR_PREVIEW = 6

type DeadLettersPanelProps = {
  onRefresh: () => void | Promise<void>
  onReplay: (id: string, createdAtIso?: string) => boolean | Promise<boolean> | undefined
  onResolve: (id: string) => boolean | Promise<boolean> | undefined
}

type PendingTriageFocus = {
  actionId: string
  neighborIds: string[]
  fallbackIndex: number
  queueSignature: string
  settled: boolean
}

function triageQueueSignature(items: DeadLetter[]): string {
  return items.map((item) => `${item.id}:${item.status}`).join('|')
}

/** Render the DLQ list with status filter, replay, and resolve controls. */
export function DeadLettersPanel({ onRefresh, onReplay, onResolve }: DeadLettersPanelProps) {
  const { t } = useT()
  // Filter/sort state + persistence + the cap-correct server fetch + the
  // recovery overlay all live in the hook; this component owns rendering, row
  // selection, and the recovery / replay-lab dialogs.
  const {
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
    filtered,
    recoveryFilterLoading,
    recoveryByDeadLetterId,
    recoveryItems,
    refresh: refreshQueue,
    loadMore,
    hasMore,
    loadingMore,
    counts,
  } = useRecoveryQueueFilters()
  const queueSectionRef = useRef<HTMLElement | null>(null)
  const queueRowRefs = useRef<Map<string, HTMLLIElement>>(new Map())
  const [queueFocusRequest, setQueueFocusRequest] = useState<RecoveryQueueFocusRequest | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingKeyboardFocusId, setPendingKeyboardFocusId] = useState<string | null>(null)
  const [pendingTriageFocus, setPendingTriageFocus] = useState<PendingTriageFocus | null>(null)
  const [replayingIds, setReplayingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [openRecoveryItemId, setOpenRecoveryItemId] = useState<string | null>(null)
  const openRecoveryItem = openRecoveryItemId
    ? recoveryItems.find((it) => it.id === openRecoveryItemId) ?? null
    : null
  const [recoveryDeadLetter, setRecoveryDeadLetter] = useState<DeadLetter | null>(null)
  const [labSourceRunId, setLabSourceRunId] = useState<string | null>(null)
  const addToast = useWorkflowStore((state) => state.addToast)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  // Multi-select for bulk resolve. `selectionMode` reveals per-row checkboxes;
  // `selectedIds` holds the ticked rows. Orthogonal to `selectedId` (the
  // single-row detail box), which is hidden while selecting.
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  // Bulk replay re-runs every ticked workflow (cost + side effects), so it
  // asks for an inline confirm first instead of firing on the first click.
  const [confirmBulkReplay, setConfirmBulkReplay] = useState(false)
  // Per-row failure reasons from the last bulk action's partial-success
  // envelope. The count toast says HOW MANY failed; this surfaces WHY (and which
  // rows), so the operator can tell a transient blip from "already replayed".
  const [bulkErrors, setBulkErrors] = useState<Array<{ deadLetterId: string; error: string }>>([])

  const handleRefresh = () => {
    refreshQueue()
    void onRefresh()
  }

  // Select-all operates over the loaded (filtered) rows, so appended
  // "Load more" pages are included; the virtual window is only a render detail.
  const loadedIds = filtered.filter((item) => !replayingIds.has(item.id)).map((item) => item.id)
  const allLoadedSelected = loadedIds.length > 0 && loadedIds.every((id) => selectedIds.has(id))

  const toggleSelect = (id: string) => {
    if (replayingIds.has(id)) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelectedIds((prev) =>
      loadedIds.length > 0 && loadedIds.every((id) => prev.has(id)) ? new Set<string>() : new Set(loadedIds),
    )
  }

  useEffect(() => {
    if (replayingIds.size === 0) return
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => !replayingIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [replayingIds])

  const exitSelection = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setConfirmBulkReplay(false)
    setBulkErrors([])
  }

  // Dismiss every ticked dead letter in one request. Mirrors the single
  // resolve's post-success behavior (bump + refetch + toast). The API uses a
  // 200 partial-success envelope, so inspect it before deciding whether to
  // clear or keep the remaining failed selections.
  const bulkResolve = async () => {
    const ids = [...selectedIds].filter((id) => !replayingIds.has(id))
    if (ids.length === 0) return
    setBulkErrors([])
    try {
      const result = await api('/dlq/bulk-resolve', { method: 'POST', body: JSON.stringify({ deadLetterIds: ids }) })
      if (!isBulkResolveResult(result)) throw new Error(t('dlq.bulkResolveFailed'))

      if (result.resolved > 0) {
        await requestRecoveryAllClearIfQueueEmpty()
        bumpPlatformVersion()
        refreshQueue()
        void onRefresh()
      }

      if (result.failed > 0) {
        const failedIds = result.errors.map((entry) => entry.deadLetterId).filter(Boolean)
        setSelectedIds(new Set(failedIds))
        setBulkErrors(result.errors)
        addToast(t('dlq.bulkResolvePartial', { resolved: result.resolved, failed: result.failed }), 'error')
        return
      }

      addToast(t('dlq.bulkResolveSuccess', { count: result.resolved }), 'success')
      exitSelection()
    } catch (error) {
      addToast(tApiError(error) || (t('dlq.bulkResolveFailed')), 'error')
    }
  }

  // Re-run every ticked dead letter in one request — the retry-many sibling of
  // bulkResolve. Same 200 partial-success envelope: on partial failure keep the
  // failed rows ticked so they stay visible for another pass; on full success
  // exit selection. Only `open` rows are replayable server-side, so an
  // already-replayed/resolved row in the selection comes back in the failed set.
  const bulkReplay = async () => {
    setConfirmBulkReplay(false)
    const ids = [...selectedIds].filter((id) => !replayingIds.has(id))
    if (ids.length === 0) return
    setBulkErrors([])
    try {
      const result = await api('/dlq/bulk-replay', { method: 'POST', body: JSON.stringify({ deadLetterIds: ids }) })
      if (!isBulkReplayResult(result)) throw new Error(t('dlq.bulkReplayFailed'))

      if (result.replayed > 0) {
        bumpPlatformVersion()
        refreshQueue()
        void onRefresh()
      }

      if (result.failed > 0) {
        const failedIds = result.errors.map((entry) => entry.deadLetterId).filter(Boolean)
        setSelectedIds(new Set(failedIds))
        setBulkErrors(result.errors)
        addToast(t('dlq.bulkReplayPartial', { replayed: result.replayed, failed: result.failed }), 'error')
        return
      }

      addToast(t('dlq.bulkReplaySuccess', { count: result.replayed }), 'success')
      exitSelection()
    } catch (error) {
      addToast(tApiError(error) || (t('dlq.bulkReplayFailed')), 'error')
    }
  }

  // Org-wide open count drives the warning stripe — there are opens to work
  // somewhere in the queue, regardless of the filtered page being viewed.
  const hasOpenEntry = counts.open > 0
  const cardSeverity: 'warning' | undefined = hasOpenEntry ? 'warning' : undefined

  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0] ?? null

  // List rows are summary projections (no workflowJson / nodeJson). Fetch the
  // full `/dlq?id=` detail for the selected row so the detail blocks and the
  // Recovery dialog get the real snapshots; the summary row is the graceful
  // fallback while loading or on fetch failure.
  const [selectedDetail, setSelectedDetail] = useState<DeadLetter | null>(null)
  // Suspect-version diff visibility — per selection, collapsed by default.
  const [showSuspectDiff, setShowSuspectDiff] = useState(false)
  const selectedRowId = selected?.id ?? null
  useEffect(() => {
    if (!selectedRowId) {
      setSelectedDetail(null)
      return
    }
    let cancelled = false
    setSelectedDetail(null)
    setShowSuspectDiff(false)
    api(`/dlq?id=${encodeURIComponent(selectedRowId)}`)
      .then((row) => {
        if (!cancelled) setSelectedDetail(row as DeadLetter)
      })
      .catch(() => {
        // Summary row keeps rendering — the detail blocks just stay lighter.
      })
    return () => {
      cancelled = true
    }
  }, [selectedRowId])
  // Merge keeps the list row's `recovery` overlay (the detail read is the raw
  // dead_letters row) while the snapshot fields come from the detail.
  const selectedFull = selected && selectedDetail && selectedDetail.id === selected.id
    ? { ...selected, ...selectedDetail, recovery: selected.recovery }
    : selected

  // Virtualize the filtered list. With 100-200 rows in the Recovery
  // Center, mounting every row as a real `<li>` costs hundreds of ms
  // of reconciliation per `platformVersion` bump. The hook renders a
  // 15-row window in the visible viewport plus overscan; jsdom + SSR
  // get all rows via the 0-height fallback so tests stay simple.
  const {
    containerRef: virtualContainerRef,
    visibleItems: visibleDeadLetters,
    totalHeight: virtualTotalHeight,
    startOffset: virtualStartOffset,
    scrollToIndex: scrollToQueueIndex,
  } = useVirtualList({
    items: filtered,
    rowHeight: DLQ_ROW_PITCH,
    // Reset scroll on filter swap, NOT on every refetch — the
    // `platformVersion`-driven refetch produces a new `filtered`
    // reference even when the content is identical, and resetting
    // scroll there would jump the operator's view to row 0 on every
    // bump. The filter signal is the real "visible set changed" cue.
    resetScrollKey: `${status}|${ownerScope}|${severityFilter}|${sortKey}`,
  })

  const focusQueueRow = useCallback((index: number) => {
    const next = filtered[index]
    if (!next) return
    setSelectedId(next.id)
    const row = queueRowRefs.current.get(next.id)
    if (row) {
      row.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      row.focus({ preventScroll: true })
      return
    }
    scrollToQueueIndex(index, 'center')
    setPendingKeyboardFocusId(next.id)
  }, [filtered, scrollToQueueIndex])

  useEffect(() => {
    if (!pendingKeyboardFocusId) return
    const row = queueRowRefs.current.get(pendingKeyboardFocusId)
    if (!row) return
    row.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    row.focus({ preventScroll: true })
    setPendingKeyboardFocusId(null)
  }, [pendingKeyboardFocusId, visibleDeadLetters])

  const runSelectedTriageAction = async (
    action: (id: string) => boolean | Promise<boolean> | undefined,
  ) => {
    if (!selected) return
    const actionIndex = filtered.findIndex((item) => item.id === selected.id)
    const neighborIds = [filtered[actionIndex + 1]?.id, filtered[actionIndex - 1]?.id]
      .filter((id): id is string => Boolean(id))
    const request: PendingTriageFocus = {
      actionId: selected.id,
      neighborIds,
      fallbackIndex: Math.max(0, actionIndex),
      queueSignature: triageQueueSignature(filtered),
      settled: false,
    }
    setPendingTriageFocus(request)
    try {
      const succeeded = await action(selected.id)
      setPendingTriageFocus((current) => (
        current?.actionId === request.actionId
          ? succeeded === false ? null : { ...current, settled: true }
          : current
      ))
    } catch {
      setPendingTriageFocus((current) => current?.actionId === request.actionId ? null : current)
    }
  }

  const replaySelected = async () => {
    if (!selected || selected.status === 'replayed' || replayingIds.has(selected.id)) return
    const replayingId = selected.id
    setReplayingIds((current) => new Set(current).add(replayingId))
    try {
      await runSelectedTriageAction((id) => onReplay(id, selected.createdAt))
    } finally {
      setReplayingIds((current) => {
        const next = new Set(current)
        next.delete(replayingId)
        return next
      })
    }
  }

  const resolveSelected = async () => {
    if (!selected || selected.status === 'resolved' || replayingIds.has(selected.id)) return
    await runSelectedTriageAction(onResolve)
  }

  useEffect(() => {
    if (!pendingTriageFocus?.settled || recoveryFilterLoading) return
    if (triageQueueSignature(filtered) === pendingTriageFocus.queueSignature) return

    const actionIndex = filtered.findIndex((item) => item.id === pendingTriageFocus.actionId)
    if (actionIndex >= 0) {
      focusQueueRow(actionIndex)
      setPendingTriageFocus(null)
      return
    }

    const neighborId = pendingTriageFocus.neighborIds.find((id) => filtered.some((item) => item.id === id))
    const neighborIndex = neighborId ? filtered.findIndex((item) => item.id === neighborId) : -1
    if (neighborIndex >= 0) {
      focusQueueRow(neighborIndex)
    } else if (filtered.length > 0) {
      focusQueueRow(Math.min(pendingTriageFocus.fallbackIndex, filtered.length - 1))
    } else {
      queueSectionRef.current?.focus({ preventScroll: true })
    }
    setPendingTriageFocus(null)
  }, [filtered, focusQueueRow, pendingTriageFocus, recoveryFilterLoading])

  useEffect(() => {
    if (!pendingTriageFocus?.settled) return
    const actionId = pendingTriageFocus.actionId
    const timeout = window.setTimeout(() => {
      setPendingTriageFocus((current) => current?.actionId === actionId ? null : current)
    }, 5_000)
    return () => window.clearTimeout(timeout)
  }, [pendingTriageFocus?.actionId, pendingTriageFocus?.settled])

  const handleQueueKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.repeat || isKeyboardShortcutTypingTarget(event.target)) return
    const key = event.key.toLowerCase()
    const hasCommandModifier = event.metaKey || event.ctrlKey

    if (!hasCommandModifier && !event.altKey && !event.shiftKey && (key === 'j' || key === 'k')) {
      const currentIndex = selected ? filtered.findIndex((item) => item.id === selected.id) : -1
      const nextIndex = key === 'j'
        ? Math.min(filtered.length - 1, Math.max(0, currentIndex + 1))
        : Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1)
      if (filtered[nextIndex]) {
        event.preventDefault()
        event.stopPropagation()
        focusQueueRow(nextIndex)
      }
      return
    }

    if (selectionMode) return
    if (!hasCommandModifier && !event.altKey && !event.shiftKey && key === 'r') {
      if (selected && selected.status !== 'replayed' && !replayingIds.has(selected.id)) {
        event.preventDefault()
        event.stopPropagation()
        void replaySelected()
      }
      return
    }

    if (hasCommandModifier && !event.altKey && !event.shiftKey && event.key === 'Enter') {
      if (selected && selected.status !== 'resolved' && !replayingIds.has(selected.id)) {
        event.preventDefault()
        event.stopPropagation()
        void resolveSelected()
      }
    }
  }

  const copySelectedError = async () => {
    const item = selectedFull ?? selected
    if (!item) return
    let copied = false
    try {
      copied = await copyText(buildRecoveryErrorSummary(item, {
        workflow: t('dlq.copy.unknownWorkflow'),
        nodeType: t('dlq.copy.unknownNodeType'),
        error: t('dlq.copy.unknownError'),
        timestamp: t('dlq.copy.unknownTimestamp'),
      }))
    } catch {
      // A browser implementation can still throw outside the guarded APIs.
    }
    addToast(
      copied ? (t('dlq.copy.success')) : (t('dlq.copy.failed')),
      copied ? 'success' : 'error',
    )
  }

  // A queue CTA may fire before this panel mounts or while it is already open.
  // Adopt both paths, then wait for the server-filtered first page before
  // scrolling/focusing. No extra fetch is introduced: the handoff consumes the
  // same bounded page the panel already owns.
  useEffect(() => {
    const pendingRequest = consumeRecoveryQueueFocus()
    if (pendingRequest) setQueueFocusRequest(pendingRequest)

    const onQueueFocus = (event: Event) => {
      const request = consumeRecoveryQueueFocus() ?? parseRecoveryQueueFocusEvent(event)
      if (request) setQueueFocusRequest(request)
    }
    window.addEventListener(RECOVERY_QUEUE_FOCUS_EVENT, onQueueFocus)
    return () => window.removeEventListener(RECOVERY_QUEUE_FOCUS_EVENT, onQueueFocus)
  }, [])

  useEffect(() => {
    if (!queueFocusRequest || recoveryFilterLoading) return
    const targetId = queueFocusRequest.deadLetterId
    if (targetId) {
      const targetIndex = filtered.findIndex((item) => item.id === targetId)
      const targetRow = queueRowRefs.current.get(targetId)
      if (!targetRow && targetIndex >= 0 && virtualContainerRef.current) {
        scrollToQueueIndex(targetIndex, 'center')
        return
      }
      if (targetRow) {
        setSelectedId(targetId)
        targetRow.scrollIntoView?.({ block: 'center', inline: 'nearest' })
        targetRow.focus({ preventScroll: true })
        setQueueFocusRequest(null)
        return
      }
    }

    const queue = queueSectionRef.current
    queue?.scrollIntoView?.({ block: 'start', inline: 'nearest' })
    queue?.focus({ preventScroll: true })
    setQueueFocusRequest(null)
  }, [filtered, queueFocusRequest, recoveryFilterLoading, scrollToQueueIndex, visibleDeadLetters])

  return (
    <>
      <FailureClustersCard />
      <AutoHealingPendingCard />
      <section
        ref={queueSectionRef}
        className="panel-card"
        data-severity={cardSeverity}
        data-testid="recovery-queue"
        tabIndex={-1}
        aria-labelledby="recovery-queue-heading"
        aria-keyshortcuts="J K R Meta+Enter Control+Enter"
        onKeyDown={handleQueueKeyDown}
      >
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('dlq.kicker')}</div>
          <strong id="recovery-queue-heading">{t('dlq.queue')}</strong>
        </div>
        <div className="split-row">
          <button
            type="button"
            className="small-command"
            aria-pressed={selectionMode}
            onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
            data-testid="dlq-select-toggle"
          >
            {selectionMode ? t('dlq.selectDone') : t('dlq.selectRows')}
          </button>
          <button className="small-command" onClick={handleRefresh}>{t('dlq.refresh')}</button>
        </div>
      </div>

      {/* Org-wide queue-health summary from /dlq/counts — NOT the filtered /
          paginated page, so the breakdown stays honest under any filter. */}
      <div className="mini-grid">
        <span><strong>{counts.total}</strong>{t('dlq.statTotal')}</span>
        <span><strong>{counts.open}</strong>{t('dlq.statOpen')}</span>
        <span><strong>{counts.replayed}</strong>{t('dlq.statRetried')}</span>
        <span><strong>{counts.resolved}</strong>{t('dlq.statResolved')}</span>
      </div>

      {dayFilter && (
        <div className="we-dlq-day-chip" data-testid="dlq-day-filter-chip">
          <span>{t('dlq.dayFilter.label', { day: dayFilter })}</span>
          <button
            type="button"
            className="we-dlq-day-chip__clear"
            onClick={clearDayFilter}
            aria-label={t('dlq.dayFilter.clear')}
            data-testid="dlq-day-filter-clear"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      <label className="field-label" htmlFor="dlq-search">{t('dlq.search.label')}</label>
      <input
        id="dlq-search"
        type="search"
        className="text-field"
        value={searchInput}
        onChange={event => setSearchInput(event.target.value)}
        placeholder={t('dlq.search.placeholder')}
        data-testid="dlq-search"
      />

      <label className="field-label" htmlFor="dlq-filter">{t('dlq.show')}</label>
      <select id="dlq-filter" className="text-field" value={status} onChange={event => setStatus(toStatusFilter(event.target.value))}>
        {statuses.map(item => <option key={item} value={item}>{t(STATUS_FILTER_KEYS[item] as never)}</option>)}
      </select>

      <div className="field-label">{t('dlq.owner.label')}</div>
      <div className="we-seg" role="group" aria-label={t('dlq.owner.aria')}>
        <button
          type="button"
          aria-pressed={ownerScope === 'all'}
          onClick={() => setOwnerScope('all')}
          data-testid="dlq-owner-all"
        >
          {t('dlq.owner.all')}
        </button>
        <button
          type="button"
          aria-pressed={ownerScope === 'mine'}
          onClick={() => setOwnerScope('mine')}
          data-testid="dlq-owner-mine"
        >
          {t('dlq.owner.mine')}
        </button>
      </div>

      <label className="field-label" htmlFor="dlq-severity-filter">{t('dlq.severity.label')}</label>
      <select
        id="dlq-severity-filter"
        className="text-field"
        value={severityFilter}
        onChange={event => setSeverityFilter(toSeverityFilter(event.target.value))}
        data-testid="dlq-severity-filter"
      >
        <option value="all">{t('dlq.severity.all')}</option>
        {SEVERITIES.map(sev => (
          <option key={sev} value={sev}>{t(`recoveryItems.severity.${sev}` as never)}</option>
        ))}
      </select>

      <label className="field-label" htmlFor="dlq-sort">{t('dlq.sort.label')}</label>
      <select
        id="dlq-sort"
        className="text-field"
        value={sortKey}
        onChange={event => setSortKey(toSortKey(event.target.value))}
        data-testid="dlq-sort"
      >
        {SORT_KEYS.map(key => (
          <option key={key} value={key}>{t(SORT_KEY_LABELS[key] as never)}</option>
        ))}
      </select>

      {/* Bulk-select bar — a Select-all toggle (always, in selection mode) plus
          the count + "Resolve selected" once at least one row is ticked. Reuses
          the Flows-list bulk-bar styling. */}
      {selectionMode && (
        <>
        <div className="we-list-bulk-bar" data-testid="dlq-bulk-bar">
          <button
            type="button"
            className="small-command"
            onClick={toggleSelectAll}
            data-testid="dlq-select-all"
          >
            {allLoadedSelected ? t('dlq.deselectAll') : t('dlq.selectAllCount', { count: loadedIds.length })}
          </button>
          {selectedIds.size > 0 && (
            <>
              <span className="we-list-bulk-bar__divider" aria-hidden="true" />
              <span className="we-list-bulk-bar__count">{t('dlq.bulkSelectedCount', { count: selectedIds.size })}</span>
              {/* Replay (recover) is the primary path; Resolve (accept the loss)
                  is the secondary dismiss. Both act on the same ticked set.
                  Replay re-runs workflows, so it goes through an inline confirm. */}
              {confirmBulkReplay ? (
                <span className="we-list-row__confirm">
                  <span className="we-list-row__confirm-text">
                    {t('dlq.bulkReplayConfirm', { count: selectedIds.size })}
                  </span>
                  <button
                    type="button"
                    className="small-command small-command--primary"
                    onClick={() => { void bulkReplay() }}
                    data-testid="dlq-bulk-replay-confirm"
                  >
                    {t('dlq.bulkReplayConfirmCta')}
                  </button>
                  <button
                    type="button"
                    className="small-command"
                    onClick={() => setConfirmBulkReplay(false)}
                  >
                    {t('common.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="small-command small-command--primary"
                  onClick={() => setConfirmBulkReplay(true)}
                  data-testid="dlq-bulk-replay"
                >
                  {t('dlq.bulkReplayCta')}
                </button>
              )}
              <button
                type="button"
                className="small-command"
                onClick={() => { void bulkResolve() }}
                data-testid="dlq-bulk-resolve"
              >
                {t('dlq.bulkResolveCta')}
              </button>
            </>
          )}
        </div>
        {/* Surface WHY rows failed (and which) from the partial-success
            envelope — the count toast alone leaves the operator guessing
            between a transient blip and "already replayed". role="alert" so a
            screen reader announces the failures. Server error strings are
            rendered verbatim (exempt from i18n per the error-message rule). */}
        {bulkErrors.length > 0 && (
          <div className="we-dlq-bulk-errors" role="alert" data-testid="dlq-bulk-errors">
            <span className="we-dlq-bulk-errors__label">
              {t('dlq.bulkErrorsHeading', { count: bulkErrors.length })}
            </span>
            <ul>
              {bulkErrors.slice(0, BULK_ERROR_PREVIEW).map((entry, idx) => (
                // Composite key: the id stays the stable identity, the index
                // disambiguates if the envelope ever carries a duplicate id.
                <li key={`${entry.deadLetterId}-${idx}`}>
                  <code>{entry.deadLetterId}</code> — {entry.error}
                </li>
              ))}
            </ul>
            {bulkErrors.length > BULK_ERROR_PREVIEW && (
              <span className="we-dlq-bulk-errors__more">
                {t('dlq.bulkErrorsMore', { count: bulkErrors.length - BULK_ERROR_PREVIEW })}
              </span>
            )}
          </div>
        )}
        </>
      )}

      <div className="panel-list">
        {recoveryFilterLoading && filtered.length === 0 && (
          <LoadingSkeleton rows={4} label={t('common.loading')} />
        )}
        {filtered.length === 0 && !recoveryFilterLoading && (
          <EmptyState
            icon={<CircleCheck />}
            kicker={t(
              searchInput.trim() !== ''
                ? 'emptyState.dlq.search.kicker'
                : severityFilter !== 'all'
                  ? 'emptyState.dlq.severity.kicker'
                  : ownerScope === 'mine'
                    ? 'emptyState.dlq.mine.kicker'
                    : 'emptyState.dlq.kicker',
            )}
            body={t(
              searchInput.trim() !== ''
                ? 'emptyState.dlq.search.body'
                : severityFilter !== 'all'
                  ? 'emptyState.dlq.severity.body'
                  : ownerScope === 'mine'
                    ? 'emptyState.dlq.mine.body'
                    : 'emptyState.dlq.body',
            )}
            testId={
              searchInput.trim() !== ''
                ? 'dlq-empty-search'
                : severityFilter !== 'all'
                  ? 'dlq-empty-severity'
                  : ownerScope === 'mine'
                    ? 'dlq-empty-mine'
                    : 'dlq-empty'
            }
          />
        )}
        {filtered.length > 0 && (
          <>
          <div ref={virtualContainerRef} className="we-virtual-list we-dlq-virtual-list" data-testid="dlq-virtual-list">
            <div style={{ height: virtualTotalHeight, position: 'relative' }}>
              <ul
                className="we-list"
                style={{ transform: `translateY(${virtualStartOffset}px)` }}
                role="grid"
                aria-labelledby="recovery-queue-heading"
                aria-multiselectable={selectionMode}
                aria-rowcount={filtered.length}
              >
                {visibleDeadLetters.map(({ item, index }) => {
                  const severity = rowSeverity(item.status)
                  const isReplaying = replayingIds.has(item.id)
                  return (
                    <li
                      key={item.id}
                      ref={(node) => {
                        if (node) queueRowRefs.current.set(item.id, node)
                        else queueRowRefs.current.delete(item.id)
                      }}
                      className="we-list-row we-dlq-row"
                      role="row"
                      data-clickable="true"
                      data-selection-mode={selectionMode ? 'true' : undefined}
                      data-severity={severity}
                      data-testid={`dlq-row-${item.id}`}
                      data-dead-letter-id={item.id}
                      data-selected={selected?.id === item.id ? 'true' : undefined}
                      tabIndex={selected?.id === item.id ? 0 : -1}
                      aria-label={`${item.nodeId} — ${isReplaying ? t('dlq.recovering') : formatStatusLabel(item.status)}`}
                      aria-selected={selectionMode ? selectedIds.has(item.id) : selected?.id === item.id}
                      aria-rowindex={index + 1}
                      onFocus={() => setSelectedId(item.id)}
                      onClick={() => (selectionMode ? toggleSelect(item.id) : setSelectedId(item.id))}
                    >
                        {selectionMode && (
                          <span role="gridcell" className="we-dlq-row__selection-cell">
                            <input
                              type="checkbox"
                              className="we-list-row__select"
                              checked={selectedIds.has(item.id)}
                              disabled={isReplaying}
                              onClick={event => event.stopPropagation()}
                              onChange={event => { event.stopPropagation(); toggleSelect(item.id) }}
                              aria-label={t('dlq.selectRowAria', { node: item.nodeId })}
                              data-testid={`dlq-select-row-${item.id}`}
                            />
                          </span>
                        )}
                        <div className="we-dlq-row__identity" role="gridcell">
                          <span className="we-list-row__avatar" aria-hidden="true"><Inbox size={14} /></span>
                          <div className="we-list-row__body">
                            <strong>{item.nodeId}</strong>
                            <small>
                              {t('dlq.runMeta', { runIdShort: item.runId.slice(0, 8), attempt: item.attempt })}
                              {item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString(getResolvedLocale())}` : ''}
                            </small>
                          </div>
                        </div>
                        <div className="we-list-row__meta" role="gridcell">
                          {item.status === 'open' && item.createdAt && (
                            <span
                              className="we-list-row__downtime"
                              data-severity={downtimeSeverity(item.createdAt, Date.now())}
                              title={t('dlq.downtimeTitle')}
                              data-testid={`dlq-downtime-${item.id}`}
                            >
                              {humanizeAge(item.createdAt, Date.now())}
                            </span>
                          )}
                          <span
                            className={`we-list-row__pill we-list-row__pill--${isReplaying ? 'cyan' : severity}`}
                            data-testid={isReplaying ? `dlq-recovering-${item.id}` : undefined}
                            role="status"
                            aria-live="polite"
                            aria-atomic="true"
                          >
                            {isReplaying && <RefreshCw size={11} className="we-spin" aria-hidden="true" />}
                            {isReplaying ? t('dlq.recovering') : formatStatusLabel(item.status)}
                          </span>
                          <RecoveryItemBadge
                            item={recoveryByDeadLetterId.get(item.id) ?? null}
                            onOpen={() => {
                              const ri = recoveryByDeadLetterId.get(item.id)
                              if (ri) setOpenRecoveryItemId(ri.id)
                            }}
                          />
                        </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
          {/* Sibling BELOW the scroll container — never buried inside the
              virtual list's internal scroll, so it stays reachable. */}
          {hasMore && (
            <button
              type="button"
              className="small-command we-load-more"
              onClick={() => { void loadMore() }}
              disabled={loadingMore}
              data-testid="dlq-load-more"
            >
              {loadingMore ? t('dlq.loadingMore') : t('dlq.loadMore')}
            </button>
          )}
          </>
        )}
        {openRecoveryItem && (
          <RecoveryItemDrawer
            item={openRecoveryItem}
            onClose={() => setOpenRecoveryItemId(null)}
          />
        )}
      </div>

      {selected && !selectionMode && (
        <section className="detail-box">
          <div className="split-row">
            <div>
              <div className="section-kicker">{t('dlq.selected')}</div>
              <strong>{selected.nodeId}</strong>
            </div>
            <span className="status-pill" data-status={replayingIds.has(selected.id) ? 'running' : selected.status}>
              {replayingIds.has(selected.id) ? t('dlq.recovering') : formatStatusLabel(selected.status)}
            </span>
          </div>

          <div className="split-row">
            <button
              className="small-command small-command--primary"
              disabled={selected.status === 'replayed' || selected.status === 'resolved'}
              onClick={() => setRecoveryDeadLetter(selectedFull ?? selected)}
            >
              <Sparkles size={12} aria-hidden="true" /> {t('dlq.action.suggest')}
            </button>
            <button
              className="small-command we-command-with-kbd"
              disabled={selected.status === 'replayed' || replayingIds.has(selected.id)}
              onClick={() => { void replaySelected() }}
            >
              <span>{t('dlq.action.retry')}</span><kbd aria-hidden="true">R</kbd>
            </button>
            <button
              className="small-command we-command-with-kbd"
              disabled={selected.status === 'resolved' || replayingIds.has(selected.id)}
              onClick={() => { void resolveSelected() }}
            >
              <span>{t('dlq.action.resolve')}</span><kbd aria-hidden="true">⌘/Ctrl ↵</kbd>
            </button>
            <button
              type="button"
              className="small-command"
              onClick={() => { void copySelectedError() }}
              data-testid="dlq-copy-error"
            >
              <Copy size={12} aria-hidden="true" /> {t('dlq.action.copyError')}
            </button>
            <button
              className="small-command"
              onClick={() => setLabSourceRunId(selected.runId)}
              data-testid="dlq-replay-in-lab"
            >
              <FlaskConical size={12} aria-hidden="true" /> {t('dlq.action.replayInLab')}
            </button>
            <button
              className="small-command"
              onClick={async () => {
                try {
                  await downloadFromApi(`/reports/run-explain?runId=${encodeURIComponent(selected.runId)}`)
                  addToast(t('dlq.exportSuccess'), 'success')
                } catch (err) {
                  addToast(tApiError(err) || (t('dlq.exportFailed')), 'error')
                }
              }}
              data-testid="dlq-export-run-explain"
              aria-label={t('dlq.action.exportAria', { runId: selected.runId })}
            >
              <Download size={12} aria-hidden="true" /> {t('dlq.action.export')}
            </button>
          </div>

          {selectedFull?.suspectVersion && (
            <div className="we-suspect-version" data-testid="dlq-suspect-version">
              <div className="split-row">
                <span className="we-suspect-version__chip">
                  <GitCompare size={12} aria-hidden="true" />
                  {t('dlq.suspectVersion.chip', {
                    version: selectedFull.suspectVersion.version,
                    time: new Date(selectedFull.suspectVersion.savedAt).toLocaleString(getResolvedLocale()),
                  })}
                </span>
                <button
                  type="button"
                  className="small-command"
                  onClick={() => setShowSuspectDiff(value => !value)}
                  data-testid="dlq-suspect-version-toggle"
                >
                  {showSuspectDiff ? t('dlq.suspectVersion.hideDiff') : t('dlq.suspectVersion.viewDiff')}
                </button>
              </div>
              {showSuspectDiff && (
                <WorkflowDiffView
                  before={selectedFull.suspectVersion.previousDagJson}
                  after={selectedFull.suspectVersion.dagJson}
                  beforeLabel={t('dlq.suspectVersion.versionLabel', { version: selectedFull.suspectVersion.previousVersion })}
                  afterLabel={t('dlq.suspectVersion.versionLabel', { version: selectedFull.suspectVersion.version })}
                />
              )}
            </div>
          )}

          <DetailBlock title={t('dlq.detail.error')} value={(selectedFull ?? selected).errorJson} />
          <DetailBlock title={t('dlq.detail.node')} value={(selectedFull ?? selected).nodeJson ?? null} />
          <DetailBlock title={t('dlq.detail.workflow')} value={(selectedFull ?? selected).workflowJson ?? null} />
        </section>
      )}
      </section>

      {recoveryDeadLetter && (
        <Suspense fallback={null}>
          <RecoveryDialog
            dlq={recoveryDeadLetter}
            onClose={() => setRecoveryDeadLetter(null)}
          />
        </Suspense>
      )}
      {labSourceRunId && (
        <ReplayLabDialog
          sourceRun={{ id: labSourceRunId, status: 'failed' }}
          onClose={() => setLabSourceRunId(null)}
        />
      )}
    </>
  )
}

function DetailBlock({ title, value }: { title: string; value: unknown }) {
  const { t } = useT()
  // Default-open the error block. Compare against both locales' rendered
  // strings so the reset-to-en between tests doesn't break the UX.
  const errorTitleEn = t('dlq.detail.error')
  const [open, setOpen] = useState(title === errorTitleEn)

  return (
    <div className="detail-block">
      <button className="small-command" onClick={() => setOpen(!open)}>
        {open ? t('dlq.detail.hide', { title }) : t('dlq.detail.show', { title })}
      </button>
      {open && <pre className="mini-pre">{JSON.stringify(value ?? {}, null, 2)}</pre>}
    </div>
  )
}

/** Severity tone for a DLQ row: open → danger, replayed → success, else cobalt. */
function rowSeverity(status: DeadLetter['status']): 'danger' | 'success' | 'cobalt' {
  if (status === 'open') return 'danger'
  if (status === 'replayed') return 'success'
  return 'cobalt'
}
