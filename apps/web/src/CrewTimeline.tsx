import React, { useMemo, useState } from 'react'

type RunEvent = { id: string; nodeId?: string | null; type: string; payload?: any; createdAt?: string }

type TimelineItem = {
  id: string
  agent: string
  type: string
  label: string
  tone: 'info' | 'success' | 'warning' | 'error'
  payload: any
  index: number
  createdAt?: string
}

function getAgentName(event: RunEvent) {
  const payload = event.payload ?? {}

  if (event.type === 'multi_agent.agent.started') return payload.name ?? 'crew'
  if (event.type === 'multi_agent.agent.completed') return payload.name ?? 'crew'
  if (payload.agent) return payload.agent

  const match = event.type.match(/^multi_agent\.agent\.(\d+)\./)
  if (match) return `agent_${Number(match[1]) + 1}`

  if (event.type.startsWith('multi_agent')) return 'crew'
  return 'workflow'
}

function getLabel(event: RunEvent) {
  const payload = event.payload ?? {}

  if (event.type === 'multi_agent.started') return `Crew started (${payload.count ?? 0})`
  if (event.type === 'multi_agent.agent.started') return `${payload.name ?? 'agent'} started`
  if (event.type.endsWith('.step.started')) return `Step ${(payload.iteration ?? 0) + 1}`
  if (event.type.endsWith('.step.planned')) return `Plan: ${payload.plan?.tool ?? 'tool'}`
  if (event.type.endsWith('.tool.started')) return `Run ${payload.tool ?? 'tool'}`
  if (event.type.endsWith('.tool.completed')) return `Tool completed`
  if (event.type.includes('reflection')) return `Reflection: ${payload.decision ?? 'decision'}`
  if (event.type === 'multi_agent.agent.completed') return `${payload.name ?? 'agent'} completed`
  if (event.type === 'multi_agent.completed') return 'Crew completed'

  return event.type
}

function getTone(event: RunEvent): TimelineItem['tone'] {
  const payload = event.payload ?? {}
  if (event.type.includes('failed') || payload.decision === 'retry') return 'error'
  if (event.type.includes('reflection')) return payload.decision === 'accept' ? 'success' : 'warning'
  if (event.type.includes('completed')) return 'success'
  if (event.type.includes('planned')) return 'warning'
  return 'info'
}

const toneStyle: Record<TimelineItem['tone'], React.CSSProperties> = {
  info: { background: '#eff6ff', borderColor: '#bfdbfe' },
  success: { background: '#f0fdf4', borderColor: '#bbf7d0' },
  warning: { background: '#fffbeb', borderColor: '#fde68a' },
  error: { background: '#fff1f2', borderColor: '#fecdd3' },
}

export function CrewTimeline({ events }: { events: RunEvent[] }) {
  const [selected, setSelected] = useState<TimelineItem | null>(null)

  const items = useMemo<TimelineItem[]>(() => {
    return events
      .filter(event => event.type.startsWith('multi_agent'))
      .map((event, index) => ({
        id: event.id ?? `${event.type}-${index}`,
        agent: getAgentName(event),
        type: event.type,
        label: getLabel(event),
        tone: getTone(event),
        payload: event.payload ?? {},
        index,
        createdAt: event.createdAt,
      }))
  }, [events])

  const lanes = useMemo(() => {
    const map = new Map<string, TimelineItem[]>()
    for (const item of items) {
      if (!map.has(item.agent)) map.set(item.agent, [])
      map.get(item.agent)!.push(item)
    }
    return Array.from(map.entries())
  }, [items])

  if (!items.length) {
    return (
      <div style={{ padding: 12, background: 'white', border: '1px solid #e5e7eb', borderRadius: 12 }}>
        <strong>Crew timeline</strong>
        <p style={{ fontSize: 12, color: '#64748b' }}>Run a MULTI_AGENT node to see the timeline.</p>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Crew Timeline</h2>
        <span style={{ fontSize: 12, color: '#64748b' }}>{items.length} events</span>
      </div>

      <div style={{ display: 'grid', gap: 14 }}>
        {lanes.map(([agent, laneItems]) => (
          <div key={agent} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <strong>{agent}</strong>
              <span style={{ fontSize: 12, color: '#64748b' }}>{laneItems.length} steps</span>
            </div>

            <div style={{ position: 'relative', paddingLeft: 20 }}>
              <div style={{ position: 'absolute', left: 6, top: 4, bottom: 4, width: 2, background: '#e2e8f0' }} />

              {laneItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => setSelected(item)}
                  style={{
                    display: 'block',
                    position: 'relative',
                    width: '100%',
                    textAlign: 'left',
                    border: `1px solid ${toneStyle[item.tone].borderColor}`,
                    borderRadius: 10,
                    padding: 9,
                    marginBottom: 8,
                    cursor: 'pointer',
                    ...toneStyle[item.tone],
                  }}
                >
                  <span style={{ position: 'absolute', left: -18, top: 12, width: 10, height: 10, borderRadius: 999, background: toneStyle[item.tone].borderColor }} />
                  <strong style={{ fontSize: 13 }}>{item.label}</strong>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 3 }}>{item.type}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div style={{ marginTop: 14, background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 12 }}>
          <strong>{selected.label}</strong>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{selected.agent} · {selected.type}</div>
          <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 10, borderRadius: 10, overflow: 'auto' }}>
            {JSON.stringify(selected.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
