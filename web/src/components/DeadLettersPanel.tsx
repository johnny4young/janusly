/**
 * Dead-letter operations panel — surfaces `dead_letters` rows with replay
 * + resolve actions. Calls `bumpPlatformVersion()` after a successful
 * replay so the Runs panel re-fetches and the row's status flips.
 *
 * Mounted by `RunsPanel.tsx` for Activity → Recover.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { api, downloadFromApi } from '../api'
import { useWorkflowStore } from '../store'
// Modal-only + heavy (~1.2k lines) — load on first open, not in the main chunk.
const RecoveryDialog = lazy(() => import('./RecoveryDialog').then((m) => ({ default: m.RecoveryDialog })))
import { ReplayLabDialog } from './ReplayLabDialog'
import { ReplayCampaignDialog } from './ReplayCampaignDialog'
import { tApiError, useT } from '../i18n'
import { useVirtualList } from '../hooks/useVirtualList'
import { isKeyboardShortcutTypingTarget } from '../keyboard-shortcut-target'
import { copyText } from '../clipboard'
import { buildRecoveryErrorSummary } from '../recovery-error-summary'
import { useRecoveryQueueFilters } from '../hooks/useRecoveryQueueFilters'
import {
  consumeRecoveryQueueFocus,
  parseRecoveryQueueFocusEvent,
  RECOVERY_QUEUE_FOCUS_EVENT,
  type RecoveryQueueFocusRequest,
} from './recovery-queue-focus-bus'
import { requestRecoveryAllClearIfQueueEmpty } from './recovery-all-clear-coordinator'
import {
  isBulkReplayResult,
  isBulkResolveResult,
  triageQueueSignature,
} from './dead-letter-model'
import type {
  BulkDeadLetterError,
  DeadLetter,
  PendingTriageFocus,
} from './dead-letter-types'
import { DeadLetterQueueView } from './DeadLetterQueueView'
import { RecoveryAutomationDisclosure } from './RecoveryAutomationDisclosure'

export type {
  DeadLetter,
  DeadLetterRecovery,
  RecoveryDrillProvenance,
  SuspectVersionInfo,
} from './dead-letter-types'

/** Fixed DLQ row height (54px) plus the 6px `.we-list` gap. The matching
 *  `.we-dlq-row` rule prevents metadata wrapping so virtual offsets stay
 *  exact even when the queue is long. */
const DLQ_ROW_PITCH = 60

type DeadLettersPanelProps = {
  onRefresh: () => void | Promise<void>
  onReplay: (id: string, createdAtIso?: string) => boolean | Promise<boolean> | undefined
  onResolve: (id: string) => boolean | Promise<boolean> | undefined
  canReplay?: boolean
  canResolve?: boolean
  canStartRuns?: boolean
  canUseRecovery?: boolean
  canReadAutoHealing?: boolean
  canDecideAutoHealing?: boolean
}

/** Render the DLQ list with status filter, replay, and resolve controls. */
export function DeadLettersPanel({
  onRefresh,
  onReplay,
  onResolve,
  canReplay = true,
  canResolve = true,
  canStartRuns = true,
  canUseRecovery = true,
  canReadAutoHealing = true,
  canDecideAutoHealing = true,
}: DeadLettersPanelProps) {
  const { t } = useT()
  // Filter/sort state + persistence + the cap-correct server fetch + the
  // recovery overlay all live in the hook; this component owns rendering, row
  // selection, and the recovery / replay-lab dialogs.
  const queue = useRecoveryQueueFilters()
  const {
    status,
    ownerScope,
    severityFilter,
    sortKey,
    filtered,
    recoveryFilterLoading,
    recoveryItems,
    refresh: refreshQueue,
    loadMore,
    counts,
  } = queue
  const queueSectionRef = useRef<HTMLElement | null>(null)
  const queueRowRefs = useRef<Map<string, HTMLLIElement>>(new Map())
  const [queueFocusRequest, setQueueFocusRequest] = useState<RecoveryQueueFocusRequest | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // An id someone explicitly asked for (alert deep link / queue CTA), as
  // opposed to one the operator clicked. Kept apart from `selectedId` because
  // the two get different treatment when the row isn't on the loaded page: a
  // request is honoured off-list, a click can't be off-list by construction.
  const [requestedId, setRequestedId] = useState<string | null>(null)
  const [offListSelected, setOffListSelected] = useState<DeadLetter | null>(null)
  const [requestedNotFound, setRequestedNotFound] = useState(false)
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
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  // Multi-select for bulk resolve. `selectionMode` reveals per-row checkboxes;
  // `selectedIds` holds the ticked rows. Orthogonal to `selectedId` (the
  // single-row detail box), which is hidden while selecting.
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  // Bulk replay re-runs every ticked workflow (cost + side effects), so it
  // asks for an inline confirm first instead of firing on the first click.
  const [confirmBulkReplay, setConfirmBulkReplay] = useState(false)
  const [confirmBulkResolve, setConfirmBulkResolve] = useState(false)
  // Per-row failure reasons from the last bulk action's partial-success
  // envelope. The count toast says HOW MANY failed; this surfaces WHY (and which
  // rows), so the operator can tell a transient blip from "already replayed".
  const [bulkErrors, setBulkErrors] = useState<BulkDeadLetterError[]>([])
  const [campaignDeadLetterIds, setCampaignDeadLetterIds] = useState<string[] | null>(null)

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
    if (!canResolve) return
    setConfirmBulkResolve(false)
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
    if (!canReplay) return
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

  const campaignCreated = (result: {
    campaign: { id: string; name: string; totalCount: number; pacingMs: number }
    publicationDeferred?: boolean
  }) => {
    setCampaignDeadLetterIds(null)
    addToast(
      result.publicationDeferred
        ? t('replayCampaign.createdDeferred', { name: result.campaign.name })
        : t('replayCampaign.created', { name: result.campaign.name, count: result.campaign.totalCount }),
      'success',
    )
    bumpPlatformVersion()
    refreshQueue()
    void onRefresh()
    exitSelection()
  }

  // Org-wide open count drives the warning stripe — there are opens to work
  // somewhere in the queue, regardless of the filtered page being viewed.
  const hasOpenEntry = counts.open > 0
  const cardSeverity: 'warning' | undefined = hasOpenEntry ? 'warning' : undefined

  // An id the operator ASKED for (a deep link from an alert, a queue CTA) must
  // never silently resolve to a different failure. The list is one filtered,
  // paginated page: an alert can point at a row that is resolved, older than
  // the page, or excluded by the filters the operator left persisted. Falling
  // back to `filtered[0]` there lands them on an unrelated incident with no
  // sign anything went wrong — worse than showing nothing. So a requested id
  // that is off-list is fetched on its own below, and only an UNREQUESTED
  // selection defaults to the first row.
  const listSelected = filtered.find(item => item.id === selectedId) ?? null
  // Off-list is a fact about the REQUESTED id versus the loaded page — not
  // about `selectedId`, which lags a render behind the request and would send
  // an in-list request down the by-id fetch for nothing.
  const requestedOffList = Boolean(requestedId) && !filtered.some(item => item.id === requestedId)
  const selected = listSelected ?? (requestedId ? offListSelected : filtered[0] ?? null) ?? null

  // Resolve a requested id the current page doesn't contain. `/dlq?id=` is
  // org-scoped and unconstrained by filters or pagination, so it can originate
  // a selection the list never had. A 404 is surfaced, not swallowed: a stale
  // alert link must say "this failure is gone", not quietly show another one.
  useEffect(() => {
    if (!requestedOffList || !requestedId) {
      setOffListSelected(null)
      setRequestedNotFound(false)
      return
    }
    let cancelled = false
    setRequestedNotFound(false)
    api(`/dlq?id=${encodeURIComponent(requestedId)}`)
      .then((row) => {
        if (!cancelled) setOffListSelected(row as DeadLetter)
      })
      .catch(() => {
        if (!cancelled) {
          setOffListSelected(null)
          setRequestedNotFound(true)
        }
      })
    return () => { cancelled = true }
  }, [requestedOffList, requestedId])

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
  }, [selectedRowId, platformVersion])
  // Merge keeps the list row's `recovery` overlay (the detail read is the raw
  // dead_letters row) while the snapshot fields come from the detail.
  const selectedFull = selected && selectedDetail && selectedDetail.id === selected.id
    ? { ...selected, ...selectedDetail, recovery: selected.recovery }
    : selected
  const selectedDetailReady = Boolean(
    selected
    && selectedDetail
    && selectedDetail.id === selected.id,
  )

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
    if (!canReplay || !selected || selected.status === 'replayed' || replayingIds.has(selected.id)) return
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
    if (!canResolve || !selected || selected.status === 'resolved' || replayingIds.has(selected.id)) return
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
      if (canReplay && selected && selected.status !== 'replayed' && !replayingIds.has(selected.id)) {
        event.preventDefault()
        event.stopPropagation()
        void replaySelected()
      }
      return
    }

    if (hasCommandModifier && !event.altKey && !event.shiftKey && event.key === 'Enter') {
      if (canResolve && selected && selected.status !== 'resolved' && !replayingIds.has(selected.id)) {
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
      // Record the ASK before resolving it. If the row isn't on this page the
      // off-list fetch takes over; without this the request would fall through
      // to "focus the queue heading" and silently drop.
      setRequestedId(targetId)
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
      // Off-list: the detail box renders it via the by-id fetch, so stop here
      // rather than falling through to the generic queue-heading focus.
      if (requestedOffList) {
        setQueueFocusRequest(null)
        return
      }
    }

    const queue = queueSectionRef.current
    queue?.scrollIntoView?.({ block: 'start', inline: 'nearest' })
    queue?.focus({ preventScroll: true })
    setQueueFocusRequest(null)
  }, [filtered, queueFocusRequest, recoveryFilterLoading, scrollToQueueIndex, visibleDeadLetters])

  const exportSelectedRunExplain = async () => {
    if (!selected) return
    try {
      await downloadFromApi(`/reports/run-explain?runId=${encodeURIComponent(selected.runId)}`)
      addToast(t('dlq.exportSuccess'), 'success')
    } catch (error) {
      addToast(tApiError(error) || t('dlq.exportFailed'), 'error')
    }
  }

  return (
    <>
      <DeadLetterQueueView
        queue={queue}
        sectionRef={queueSectionRef}
        rowRefs={queueRowRefs}
        cardSeverity={cardSeverity}
        virtual={{
          containerRef: virtualContainerRef,
          visibleItems: visibleDeadLetters,
          totalHeight: virtualTotalHeight,
          startOffset: virtualStartOffset,
        }}
        selection={{
          selectionMode,
          selectedIds,
          selected,
          selectedFull,
          selectedDetailReady,
          requestedNotFound,
          replayingIds,
          openRecoveryItem,
          confirmBulkReplay,
          confirmBulkResolve,
          bulkErrors,
          loadedIds,
          allLoadedSelected,
          showSuspectDiff,
        }}
        permissions={{ canReplay, canResolve, canStartRuns, canUseRecovery }}
        actions={{
          handleKeyDown: handleQueueKeyDown,
          toggleSelectionMode: () => (selectionMode ? exitSelection() : setSelectionMode(true)),
          refresh: handleRefresh,
          toggleSelectAll,
          toggleSelect,
          setConfirmBulkReplay,
          setConfirmBulkResolve,
          bulkReplay,
          bulkResolve,
          createReplayCampaign: setCampaignDeadLetterIds,
          selectRow: setSelectedId,
          openRecoveryItem: setOpenRecoveryItemId,
          loadMore,
          startRecovery: setRecoveryDeadLetter,
          replaySelected,
          resolveSelected,
          copySelectedError,
          openReplayLab: setLabSourceRunId,
          exportRunExplain: exportSelectedRunExplain,
          toggleSuspectDiff: () => setShowSuspectDiff((value) => !value),
        }}
      />
      <RecoveryAutomationDisclosure
        canRecover={canUseRecovery}
        canCancelCampaign={canReplay}
        canReadAutoHealing={canReadAutoHealing}
        canDecideAutoHealing={canDecideAutoHealing}
      />

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
      {campaignDeadLetterIds && (
        <ReplayCampaignDialog
          deadLetterIds={campaignDeadLetterIds}
          onClose={() => setCampaignDeadLetterIds(null)}
          onCreated={campaignCreated}
        />
      )}
    </>
  )
}
