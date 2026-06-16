/**
 * Dead-letter operations panel — surfaces `dead_letters` rows with replay
 * + resolve actions. Calls `bumpPlatformVersion()` after a successful
 * replay so the Runs panel re-fetches and the row's status flips.
 *
 * Used by `RightPanel.tsx` (`runs` tab → Operations card).
 */

import { lazy, Suspense, useState } from 'react'
import { CircleCheck, Download, FlaskConical, Inbox, Sparkles } from 'lucide-react'
import { downloadFromApi } from '../api'
import { formatStatusLabel } from '../constants'
import { useWorkflowStore } from '../store'
import { EmptyState } from './EmptyState'
import { FailureClustersCard } from './FailureClustersCard'
import { AutoHealingPendingCard } from './AutoHealingPendingCard'
// Modal-only + heavy (~1.2k lines) — load on first open, not in the main chunk.
const RecoveryDialog = lazy(() => import('./RecoveryDialog').then((m) => ({ default: m.RecoveryDialog })))
import { ReplayLabDialog } from './ReplayLabDialog'
import { RecoveryItemBadge } from './RecoveryItemBadge'
import { RecoveryItemDrawer } from './RecoveryItemDrawer'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useVirtualList } from '../hooks/useVirtualList'
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

/** Row PITCH in CSS pixels for the virtualized DLQ list — the full
 *  distance from one row's top to the next row's top in the flex
 *  flow. That's the visual height of `.we-list-row` (~48px) PLUS the
 *  `gap: 6px` `.we-list` applies between flex children. Using row
 *  pitch (54px) instead of just the row height keeps the windowing
 *  math aligned with the actual scroll surface — otherwise the
 *  spacer undercounts by `(items.length - 1) × 6px` and the operator
 *  can't reach the bottom of long lists. Tune here if either value
 *  changes (row chrome height or `.we-list`'s gap). */
const DLQ_ROW_HEIGHT = 54

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
  workflowId?: string | null
  occurrenceCount?: number
  lastOccurredAt?: string
}

/** Web-side `dead_letters` row shape (matches the API's response). `recovery`
 *  is the inline overlay (null when the row has no paired recovery item). */
export type DeadLetter = {
  id: string
  runId: string
  nodeId: string
  attempt: number
  status: 'open' | 'replayed' | 'resolved' | string
  workflowJson: unknown
  nodeJson: unknown
  errorJson: unknown
  createdAt?: string
  replayedAt?: string
  recovery?: DeadLetterRecovery | null
}

type DeadLettersPanelProps = {
  onRefresh: () => void | Promise<void>
  onReplay: (id: string) => void
  onResolve: (id: string) => void
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
    ownerScope,
    setOwnerScope,
    severityFilter,
    setSeverityFilter,
    sortKey,
    setSortKey,
    filtered,
    recoveryFilterLoading,
    recoveryByDeadLetterId,
    recoveryItems,
    refresh: refreshQueue,
    loadMore,
    hasMore,
    loadingMore,
  } = useRecoveryQueueFilters()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openRecoveryItemId, setOpenRecoveryItemId] = useState<string | null>(null)
  const openRecoveryItem = openRecoveryItemId
    ? recoveryItems.find((it) => it.id === openRecoveryItemId) ?? null
    : null
  const [recoveryDeadLetter, setRecoveryDeadLetter] = useState<DeadLetter | null>(null)
  const [labSourceRunId, setLabSourceRunId] = useState<string | null>(null)
  const addToast = useWorkflowStore((state) => state.addToast)

  const handleRefresh = () => {
    refreshQueue()
    void onRefresh()
  }

  const hasOpenEntry = filtered.some((item) => item.status === 'open')
  const cardSeverity: 'warning' | undefined = hasOpenEntry ? 'warning' : undefined

  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0] ?? null

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
  } = useVirtualList({
    items: filtered,
    rowHeight: DLQ_ROW_HEIGHT,
    // Reset scroll on filter swap, NOT on every refetch — the
    // `platformVersion`-driven refetch produces a new `filtered`
    // reference even when the content is identical, and resetting
    // scroll there would jump the operator's view to row 0 on every
    // bump. The filter signal is the real "visible set changed" cue.
    resetScrollKey: `${status}|${ownerScope}|${severityFilter}|${sortKey}`,
  })

  return (
    <>
      <FailureClustersCard />
      <AutoHealingPendingCard />
      <section className="panel-card" data-severity={cardSeverity}>
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('dlq.kicker')}</div>
          <strong>{t('dlq.queue')}</strong>
        </div>
        <button className="small-command" onClick={handleRefresh}>{t('dlq.refresh')}</button>
      </div>

      <div className="mini-grid">
        <span><strong>{filtered.length}</strong>{t('dlq.statTotal')}</span>
        <span><strong>{filtered.filter(item => item.status === 'open').length}</strong>{t('dlq.statOpen')}</span>
        <span><strong>{filtered.filter(item => item.status === 'replayed').length}</strong>{t('dlq.statRetried')}</span>
        <span><strong>{filtered.filter(item => item.status === 'resolved').length}</strong>{t('dlq.statResolved')}</span>
      </div>

      <label className="field-label" htmlFor="dlq-filter">{t('dlq.show')}</label>
      <select id="dlq-filter" className="text-field" value={status} onChange={event => setStatus(toStatusFilter(event.target.value))}>
        {statuses.map(item => <option key={item} value={item}>{t(STATUS_FILTER_KEYS[item] as never) as string}</option>)}
      </select>

      <div className="field-label">{t('dlq.owner.label')}</div>
      <div className="we-seg" role="group" aria-label={t('dlq.owner.aria') as string}>
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
          <option key={sev} value={sev}>{t(`recoveryItems.severity.${sev}` as never) as string}</option>
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
          <option key={key} value={key}>{t(SORT_KEY_LABELS[key] as never) as string}</option>
        ))}
      </select>

      <div className="panel-list">
        {filtered.length === 0 && !recoveryFilterLoading && (
          <EmptyState
            icon={<CircleCheck />}
            kicker={t(
              severityFilter !== 'all'
                ? 'emptyState.dlq.severity.kicker'
                : ownerScope === 'mine'
                  ? 'emptyState.dlq.mine.kicker'
                  : 'emptyState.dlq.kicker',
            ) as string}
            body={t(
              severityFilter !== 'all'
                ? 'emptyState.dlq.severity.body'
                : ownerScope === 'mine'
                  ? 'emptyState.dlq.mine.body'
                  : 'emptyState.dlq.body',
            ) as string}
            testId={
              severityFilter !== 'all'
                ? 'dlq-empty-severity'
                : ownerScope === 'mine'
                  ? 'dlq-empty-mine'
                  : 'dlq-empty'
            }
          />
        )}
        {filtered.length > 0 && (
          <>
          <div ref={virtualContainerRef} className="we-virtual-list" data-testid="dlq-virtual-list">
            <div style={{ height: virtualTotalHeight, position: 'relative' }}>
              <ul className="we-list" style={{ transform: `translateY(${virtualStartOffset}px)` }}>
                {visibleDeadLetters.map(({ item }) => {
                  const severity = rowSeverity(item.status)
                  return (
                    <li key={item.id}>
                      <div
                        className="we-list-row"
                        data-clickable="true"
                        data-severity={severity}
                        data-testid={`dlq-row-${item.id}`}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <span className="we-list-row__avatar" aria-hidden="true"><Inbox size={14} /></span>
                        <div className="we-list-row__body">
                          <strong>{item.nodeId}</strong>
                          <small>
                            {t('dlq.runMeta', { runIdShort: item.runId.slice(0, 8), attempt: item.attempt })}
                            {item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString(getResolvedLocale())}` : ''}
                          </small>
                        </div>
                        <div className="we-list-row__meta">
                          <span className={`we-list-row__pill we-list-row__pill--${severity}`}>
                            {formatStatusLabel(item.status)}
                          </span>
                          <RecoveryItemBadge
                            item={recoveryByDeadLetterId.get(item.id) ?? null}
                            onOpen={() => {
                              const ri = recoveryByDeadLetterId.get(item.id)
                              if (ri) setOpenRecoveryItemId(ri.id)
                            }}
                          />
                        </div>
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

      {selected && (
        <section className="detail-box">
          <div className="split-row">
            <div>
              <div className="section-kicker">{t('dlq.selected')}</div>
              <strong>{selected.nodeId}</strong>
            </div>
            <span className="status-pill" data-status={selected.status}>{formatStatusLabel(selected.status)}</span>
          </div>

          <div className="split-row">
            <button
              className="small-command small-command--primary"
              disabled={selected.status === 'replayed' || selected.status === 'resolved'}
              onClick={() => setRecoveryDeadLetter(selected)}
            >
              <Sparkles size={12} aria-hidden="true" /> {t('dlq.action.suggest')}
            </button>
            <button className="small-command" disabled={selected.status === 'replayed'} onClick={() => onReplay(selected.id)}>
              {t('dlq.action.retry')}
            </button>
            <button className="small-command" disabled={selected.status === 'resolved'} onClick={() => onResolve(selected.id)}>
              {t('dlq.action.resolve')}
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
                  addToast(tApiError(err) || (t('dlq.exportFailed') as string), 'error')
                }
              }}
              data-testid="dlq-export-run-explain"
              aria-label={t('dlq.action.exportAria', { runId: selected.runId }) as string}
            >
              <Download size={12} aria-hidden="true" /> {t('dlq.action.export')}
            </button>
          </div>

          <DetailBlock title={t('dlq.detail.error') as string} value={selected.errorJson} />
          <DetailBlock title={t('dlq.detail.node') as string} value={selected.nodeJson} />
          <DetailBlock title={t('dlq.detail.workflow') as string} value={selected.workflowJson} />
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
  const errorTitleEn = t('dlq.detail.error') as string
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
