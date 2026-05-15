/**
 * Dead-letter operations panel — surfaces `dead_letters` rows with replay
 * + resolve actions. Calls `bumpPlatformVersion()` after a successful
 * replay so the Runs panel re-fetches and the row's status flips.
 *
 * Used by `RightPanel.tsx` (`runs` tab → Operations card).
 */

import React, { useMemo, useState } from 'react'
import { Download, FlaskConical, Sparkles } from 'lucide-react'
import { downloadFromApi } from '../api'
import { formatStatusLabel } from '../constants'
import { useWorkflowStore } from '../store'
import { FailureClustersCard } from './FailureClustersCard'
import { RecoveryDialog } from './RecoveryDialog'
import { ReplayLabDialog } from './ReplayLabDialog'
import { getResolvedLocale, tApiError, useT } from '../i18n'

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
  const [recoveryDeadLetter, setRecoveryDeadLetter] = useState<DeadLetter | null>(null)
  const [labSourceRunId, setLabSourceRunId] = useState<string | null>(null)
  const addToast = useWorkflowStore((state) => state.addToast)

  const filtered = useMemo(() => {
    if (status === 'all') return deadLetters
    return deadLetters.filter(item => item.status === status)
  }, [deadLetters, status])

  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0] ?? null

  return (
    <>
      <FailureClustersCard />
      <section className="panel-card">
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
          <div className="empty-panel empty-panel-compact">
            <strong>{t('dlq.empty')}</strong>
            <p>{t('dlq.emptyHelper')}</p>
          </div>
        )}
        {filtered.map(item => (
          <button key={item.id} className="list-card list-card-button" onClick={() => setSelectedId(item.id)}>
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{item.nodeId}</strong>
              <span className="status-pill" data-status={item.status}>{formatStatusLabel(item.status)}</span>
            </div>
            <span>{t('dlq.runMeta', { runIdShort: item.runId.slice(0, 8), attempt: item.attempt })}</span>
            <span>{item.createdAt ? new Date(item.createdAt).toLocaleString(getResolvedLocale()) : t('dlq.failedHandoff')}</span>
          </button>
        ))}
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
