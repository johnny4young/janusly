/**
 * Dead-letter operations panel — surfaces `dead_letters` rows with replay
 * + resolve actions. Calls `bumpPlatformVersion()` after a successful
 * replay so the Runs panel re-fetches and the row's status flips.
 *
 * Used by `RightPanel.tsx` (`runs` tab → Operations card).
 */

import React, { useMemo, useState } from 'react'
import { formatStatusLabel } from '../constants'

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
const statusLabels: Record<DeadLetterStatusFilter, string> = {
  all: 'All',
  open: 'Open',
  replayed: 'Retried',
  resolved: 'Resolved',
}

/** Render the DLQ list with status filter, replay, and resolve controls. */
export function DeadLettersPanel({ deadLetters, onRefresh, onReplay, onResolve }: DeadLettersPanelProps) {
  const [status, setStatus] = useState<DeadLetterStatusFilter>('open')
  const [selectedId, setSelectedId] = useState<string | null>(deadLetters[0]?.id ?? null)

  const filtered = useMemo(() => {
    if (status === 'all') return deadLetters
    return deadLetters.filter(item => item.status === status)
  }, [deadLetters, status])

  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0] ?? null

  return (
    <section className="panel-card">
      <div className="split-row">
        <div>
          <div className="section-kicker">Operations</div>
          <strong>Recovery queue</strong>
        </div>
        <button className="small-command" onClick={onRefresh}>Refresh</button>
      </div>

      <div className="mini-grid">
        <span><strong>{deadLetters.length}</strong>Total</span>
        <span><strong>{deadLetters.filter(item => item.status === 'open').length}</strong>Open</span>
        <span><strong>{deadLetters.filter(item => item.status === 'replayed').length}</strong>Retried</span>
        <span><strong>{deadLetters.filter(item => item.status === 'resolved').length}</strong>Resolved</span>
      </div>

      <label className="field-label" htmlFor="dlq-filter">Show</label>
      <select id="dlq-filter" className="text-field" value={status} onChange={event => setStatus(toStatusFilter(event.target.value))}>
        {statuses.map(item => <option key={item} value={item}>{statusLabels[item]}</option>)}
      </select>

      <div className="panel-list">
        {filtered.length === 0 && (
          <div className="empty-panel empty-panel-compact">
            <strong>No failed handoffs</strong>
            <p>This view is clear for the selected filter.</p>
          </div>
        )}
        {filtered.map(item => (
          <button key={item.id} className="list-card list-card-button" onClick={() => setSelectedId(item.id)}>
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{item.nodeId}</strong>
              <span className="status-pill" data-status={item.status}>{formatStatusLabel(item.status)}</span>
            </div>
            <span>run {item.runId.slice(0, 8)}… / attempt {item.attempt}</span>
            <span>{item.createdAt ? new Date(item.createdAt).toLocaleString() : 'failed handoff'}</span>
          </button>
        ))}
      </div>

      {selected && (
        <section className="detail-box">
          <div className="split-row">
            <div>
              <div className="section-kicker">Selected</div>
              <strong>{selected.nodeId}</strong>
            </div>
            <span className="status-pill" data-status={selected.status}>{formatStatusLabel(selected.status)}</span>
          </div>

          <div className="split-row">
            <button className="small-command" disabled={selected.status === 'replayed'} onClick={() => onReplay(selected.id)}>
              Retry
            </button>
            <button className="small-command" disabled={selected.status === 'resolved'} onClick={() => onResolve(selected.id)}>
              Resolve
            </button>
          </div>

          <DetailBlock title="Error details" value={selected.errorJson} />
          <DetailBlock title="Step payload" value={selected.nodeJson} />
          <DetailBlock title="Flow payload" value={selected.workflowJson} />
        </section>
      )}
    </section>
  )
}

function DetailBlock({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(title === 'Error details')

  return (
    <div className="detail-block">
      <button className="small-command" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {title}</button>
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
