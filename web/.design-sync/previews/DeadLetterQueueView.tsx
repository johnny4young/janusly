import { useRef } from 'react'
import { DeadLetterQueueView } from '@janusly/web'
import { deadLetter } from './_fixtures'

/**
 * The recovery queue. `DeadLettersPanel` owns the data loading, mutations and
 * dialogs; this component renders the controls, the virtualized rows and the
 * selected failure's detail pane, so it is renderable from plain data.
 *
 * Two things are worth reading before designing with it. `queue.counts` is the
 * whole org's DLQ breakdown, **not** the filtered page — the mini-grid stays
 * stable while filters move. And `virtual` is a windowing slice: `visibleItems`
 * are the rows currently rendered, positioned inside `totalHeight` at
 * `startOffset`, which is why the list scrolls to thousands of rows without
 * mounting them.
 *
 * The recovery overlay (`recoveryByDeadLetterId`, `recoveryItems`) is empty
 * here — most dead letters have no incident attached, and that is the ordinary
 * row. `RecoveryItemBadge` and `RecoveryItemDrawer` have their own cards.
 */

const rows = [
  deadLetter,
  { ...deadLetter, id: 'dlq_7c1e08', runId: 'run_2ad118', status: 'replayed', createdAt: '2026-08-25T02:00:28.000Z' },
  { ...deadLetter, id: 'dlq_9b30ce', runId: 'run_5c7712', nodeId: 'charge_card', workflowName: 'Refund audit', status: 'open', createdAt: '2026-08-25T18:22:10.000Z', errorJson: { message: 'Secret `stripe_restricted_key` is not configured.', status: 400 } },
  { ...deadLetter, id: 'dlq_2b9f44', runId: 'run_44b0f1', status: 'resolved', createdAt: '2026-08-24T02:00:31.000Z' },
]

const noop = () => {}
const asyncNoop = async () => {}

const queue = {
  status: 'all' as const,
  setStatus: noop,
  ownerScope: 'all' as const,
  setOwnerScope: noop,
  severityFilter: 'all' as const,
  setSeverityFilter: noop,
  sortKey: 'newest' as const,
  setSortKey: noop,
  searchInput: '',
  setSearchInput: noop,
  dayFilter: null,
  clearDayFilter: noop,
  filtered: rows,
  recoveryFilterLoading: false,
  recoveryByDeadLetterId: new Map(),
  recoveryItems: [],
  refresh: noop,
  loadMore: noop,
  hasMore: false,
  loadingMore: false,
  counts: { total: 68, open: 12, replayed: 41, resolved: 15 },
}

const permissions = { canReplay: true, canResolve: true, canStartRuns: true, canUseRecovery: true }

const actions = {
  handleKeyDown: noop,
  toggleSelectionMode: noop,
  refresh: noop,
  toggleSelectAll: noop,
  toggleSelect: noop,
  setConfirmBulkReplay: noop,
  setConfirmBulkResolve: noop,
  bulkReplay: asyncNoop,
  bulkResolve: asyncNoop,
  createReplayCampaign: noop,
  selectRow: noop,
  openRecoveryItem: noop,
  loadMore: noop,
  startRecovery: noop,
  replaySelected: asyncNoop,
  resolveSelected: asyncNoop,
  copySelectedError: asyncNoop,
  openReplayLab: noop,
  exportRunExplain: asyncNoop,
  toggleSuspectDiff: noop,
}

const baseSelection = {
  selectionMode: false,
  selectedIds: new Set<string>(),
  selected: deadLetter,
  selectedFull: deadLetter,
  selectedDetailReady: true,
  requestedNotFound: false,
  replayingIds: new Set<string>(),
  openRecoveryItem: null,
  confirmBulkReplay: false,
  confirmBulkResolve: false,
  bulkErrors: [],
  loadedIds: rows.map((row) => row.id),
  allLoadedSelected: false,
  showSuspectDiff: false,
}

function Queue({ selection }: { selection: typeof baseSelection }) {
  const sectionRef = useRef<HTMLElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const containerRef = useRef<HTMLDivElement | null>(null)
  return (
    <DeadLetterQueueView
      queue={queue}
      sectionRef={sectionRef}
      rowRefs={rowRefs}
      cardSeverity="warning"
      virtual={{
        containerRef,
        // Each entry is tagged with its absolute index in the full list — a bare
        // row array is NOT the shape, and the view crashes on it.
        visibleItems: rows.map((item, index) => ({ item, index })),
        totalHeight: rows.length * 96,
        startOffset: 0,
      }}
      selection={selection}
      permissions={permissions}
      actions={actions}
    />
  )
}

/** Triage: one failure selected, its detail open beside the list. */
export function Triage() {
  return <Queue selection={baseSelection} />
}

/** Bulk mode: two rows picked for a single replay or resolve. */
export function BulkSelection() {
  return (
    <Queue
      selection={{
        ...baseSelection,
        selectionMode: true,
        selectedIds: new Set(['dlq_4f2a91', 'dlq_9b30ce']),
      }}
    />
  )
}
