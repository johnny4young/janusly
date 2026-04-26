import React, { useMemo, useState } from 'react'

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

export function DeadLettersPanel({ deadLetters, onRefresh, onReplay, onResolve }: DeadLettersPanelProps) {
  const [status, setStatus] = useState<'all' | 'open' | 'replayed' | 'resolved'>('open')
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
          <strong>Dead Letters</strong>
        </div>
        <button className="small-command" onClick={onRefresh}>Refresh</button>
      </div>

      <div className="mini-grid">
        <span>Total: {deadLetters.length}</span>
        <span>Open: {deadLetters.filter(item => item.status === 'open').length}</span>
        <span>Replayed: {deadLetters.filter(item => item.status === 'replayed').length}</span>
        <span>Resolved: {deadLetters.filter(item => item.status === 'resolved').length}</span>
      </div>

      <label className="field-label" htmlFor="dlq-filter">Status filter</label>
      <select id="dlq-filter" className="text-field" value={status} onChange={event => setStatus(event.target.value as any)}>
        <option value="all">all</option>
        <option value="open">open</option>
        <option value="replayed">replayed</option>
        <option value="resolved">resolved</option>
      </select>

      <div className="panel-list">
        {filtered.length === 0 && <p className="empty-state">No dead letters for this filter.</p>}
        {filtered.map(item => (
          <button key={item.id} className="list-card list-card-button" onClick={() => setSelectedId(item.id)}>
            <div className="split-row" style={{ width: '100%' }}>
              <strong>{item.nodeId}</strong>
              <span className="status-pill" data-status={item.status}>{item.status}</span>
            </div>
            <span>run {item.runId.slice(0, 8)}… / attempt {item.attempt}</span>
            <span>{item.createdAt ? new Date(item.createdAt).toLocaleString() : 'dead letter'}</span>
          </button>
        ))}
      </div>

      {selected && (
        <section className="panel-card">
          <div className="split-row">
            <div>
              <div className="section-kicker">Selected</div>
              <strong>{selected.nodeId}</strong>
            </div>
            <span className="status-pill" data-status={selected.status}>{selected.status}</span>
          </div>

          <div className="split-row">
            <button className="small-command" disabled={selected.status === 'replayed'} onClick={() => onReplay(selected.id)}>
              Replay
            </button>
            <button className="small-command" disabled={selected.status === 'resolved'} onClick={() => onResolve(selected.id)}>
              Resolve
            </button>
          </div>

          <DetailBlock title="Error JSON" value={selected.errorJson} />
          <DetailBlock title="Node JSON" value={selected.nodeJson} />
          <DetailBlock title="Workflow JSON" value={selected.workflowJson} />
        </section>
      )}
    </section>
  )
}

function DetailBlock({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(title === 'Error JSON')

  return (
    <div className="list-card">
      <button className="small-command" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {title}</button>
      {open && <pre className="mini-pre">{JSON.stringify(value ?? {}, null, 2)}</pre>}
    </div>
  )
}
