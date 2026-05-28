/**
 * Dead-letter operations panel — surfaces `dead_letters` rows with replay
 * + resolve actions. Calls `bumpPlatformVersion()` after a successful
 * replay so the Runs panel re-fetches and the row's status flips.
 *
 * Used by `RightPanel.tsx` (`runs` tab → Operations card).
 */

import React, { useEffect, useMemo, useState } from 'react'
import { CircleCheck, Download, FlaskConical, Inbox, Sparkles } from 'lucide-react'
import { api, downloadFromApi } from '../api'
import { formatStatusLabel } from '../constants'
import { useWorkflowStore } from '../store'
import { EmptyState } from './EmptyState'
import { FailureClustersCard } from './FailureClustersCard'
import { AutoHealingPendingCard } from './AutoHealingPendingCard'
import { RecoveryDialog } from './RecoveryDialog'
import { ReplayLabDialog } from './ReplayLabDialog'
import { RecoveryItemBadge, type RecoveryItemBadgeData } from './RecoveryItemBadge'
import { RecoveryItemDrawer, type RecoveryItemDrawerData } from './RecoveryItemDrawer'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useVirtualList } from '../hooks/useVirtualList'

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

/** Web-side `dead_letters` row shape (matches the API's response). */
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
}

type DeadLettersPanelProps = {
  deadLetters: DeadLetter[]
  onRefresh: () => void
  onReplay: (id: string) => void
  onResolve: (id: string) => void
}

const statuses = ['all', 'open', 'replayed', 'resolved'] as const
type DeadLetterStatusFilter = typeof statuses[number]
const STATUS_FILTER_KEYS: Record<DeadLetterStatusFilter, string> = {
  all: 'dlq.filter.all',
  open: 'dlq.filter.open',
  replayed: 'dlq.filter.replayed',
  resolved: 'dlq.filter.resolved',
}

/** Render the DLQ list with status filter, replay, and resolve controls. */
export function DeadLettersPanel({ deadLetters, onRefresh, onReplay, onResolve }: DeadLettersPanelProps) {
  const { t } = useT()
  const [status, setStatus] = useState<DeadLetterStatusFilter>('open')
  const [selectedId, setSelectedId] = useState<string | null>(deadLetters[0]?.id ?? null)
  const [recoveryItems, setRecoveryItems] = useState<
    Array<RecoveryItemBadgeData & RecoveryItemDrawerData>
  >([])
  const [openRecoveryItemId, setOpenRecoveryItemId] = useState<string | null>(null)
  const platformVersion = useWorkflowStore((s) => s.platformVersion)

  useEffect(() => {
    let cancelled = false
    api('/recovery/items?limit=200')
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
      })
      .catch(() => {
        if (!cancelled) setRecoveryItems([])
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion])

  const recoveryByDeadLetterId = useMemo(() => {
    const map = new Map<string, RecoveryItemBadgeData & RecoveryItemDrawerData>()
    for (const it of recoveryItems) map.set(it.deadLetterId, it)
    return map
  }, [recoveryItems])

  const openRecoveryItem = openRecoveryItemId
    ? recoveryItems.find((it) => it.id === openRecoveryItemId) ?? null
    : null
  const [recoveryDeadLetter, setRecoveryDeadLetter] = useState<DeadLetter | null>(null)
  const [labSourceRunId, setLabSourceRunId] = useState<string | null>(null)
  const addToast = useWorkflowStore((state) => state.addToast)

  const filtered = useMemo(() => {
    if (status === 'all') return deadLetters
    return deadLetters.filter(item => item.status === status)
  }, [deadLetters, status])

  const hasOpenEntry = deadLetters.some((item) => item.status === 'open')
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
    // Reset scroll on filter swap, NOT on every parent refetch — the
    // `platformVersion`-driven refetch produces a new `deadLetters`
    // reference even when the content is identical, and resetting
    // scroll there would jump the operator's view to row 0 on every
    // bump. The filter signal is the real "visible set changed" cue.
    resetScrollKey: status,
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
        <button className="small-command" onClick={onRefresh}>{t('dlq.refresh')}</button>
      </div>

      <div className="mini-grid">
        <span><strong>{deadLetters.length}</strong>{t('dlq.statTotal')}</span>
        <span><strong>{deadLetters.filter(item => item.status === 'open').length}</strong>{t('dlq.statOpen')}</span>
        <span><strong>{deadLetters.filter(item => item.status === 'replayed').length}</strong>{t('dlq.statRetried')}</span>
        <span><strong>{deadLetters.filter(item => item.status === 'resolved').length}</strong>{t('dlq.statResolved')}</span>
      </div>

      <label className="field-label" htmlFor="dlq-filter">{t('dlq.show')}</label>
      <select id="dlq-filter" className="text-field" value={status} onChange={event => setStatus(toStatusFilter(event.target.value))}>
        {statuses.map(item => <option key={item} value={item}>{t(STATUS_FILTER_KEYS[item] as never) as string}</option>)}
      </select>

      <div className="panel-list">
        {filtered.length === 0 && (
          <EmptyState
            icon={<CircleCheck />}
            kicker={t('emptyState.dlq.kicker') as string}
            body={t('emptyState.dlq.body') as string}
            testId="dlq-empty"
          />
        )}
        {filtered.length > 0 && (
          <div ref={virtualContainerRef} className="we-virtual-list" data-testid="dlq-virtual-list">
            <div style={{ height: virtualTotalHeight, position: 'relative' }}>
              <ul className="we-list" style={{ transform: `translateY(${virtualStartOffset}px)` }}>
                {visibleDeadLetters.map(({ item }) => {
                  const severity = item.status === 'open' ? 'danger' : item.status === 'replayed' ? 'success' : 'cobalt'
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
                          <span className={`we-list-row__pill we-list-row__pill--${severity === 'danger' ? 'danger' : severity === 'success' ? 'success' : 'cobalt'}`}>
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
        <RecoveryDialog
          dlq={recoveryDeadLetter}
          onClose={() => setRecoveryDeadLetter(null)}
        />
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

function toStatusFilter(value: string): DeadLetterStatusFilter {
  for (const status of statuses) {
    if (status === value) return status
  }
  return 'open'
}
