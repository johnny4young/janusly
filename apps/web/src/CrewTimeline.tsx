import React, { useMemo, useState } from 'react'
import type { JsonObject, RunEvent } from './types'

type Tone = 'info' | 'success' | 'warning' | 'error'

type TimelineItem = {
  id: string
  agent: string
  type: string
  label: string
  tone: Tone
  payload: JsonObject
  index: number
  createdAt?: string
}

function getAgentName(event: RunEvent): string {
  const payload = event.payload ?? {}

  if (event.type === 'multi_agent.agent.started') return typeof payload.name === 'string' ? payload.name : 'crew'
  if (event.type === 'multi_agent.agent.completed') return typeof payload.name === 'string' ? payload.name : 'crew'
  if (typeof payload.name === 'string') return payload.name
  if (typeof payload.agent === 'string') return payload.agent

  const match = event.type.match(/^multi_agent\.agent\.(\d+)\./)
  if (match) return `agent_${Number(match[1]) + 1}`

  if (event.type.startsWith('multi_agent')) return 'crew'
  return 'workflow'
}

function getLabel(event: RunEvent): string {
  const payload = event.payload ?? {}

  if (event.type === 'multi_agent.started') return `Crew started (${payload.count ?? 0})`
  if (event.type === 'multi_agent.agent.started') return `${typeof payload.name === 'string' ? payload.name : 'agent'} started`
  if (event.type.match(/^multi_agent\.agent\.\d+\.started$/)) return `${typeof payload.name === 'string' ? payload.name : 'agent'} started`
  if (event.type.match(/^multi_agent\.agent\.\d+\.completed$/)) return `${typeof payload.name === 'string' ? payload.name : 'agent'} completed`
  if (event.type.endsWith('.step.started')) return `Step ${readNumber(payload.iteration) + 1}`
  if (event.type.endsWith('.step.planned')) return `Plan: ${readNestedString(payload, ['plan', 'tool']) ?? 'tool'}`
  if (event.type.endsWith('.tool.started')) return `Run ${typeof payload.tool === 'string' ? payload.tool : 'tool'}`
  if (event.type.endsWith('.tool.completed')) return 'Tool completed'
  if (event.type.includes('reflection')) return `Reflection: ${typeof payload.decision === 'string' ? payload.decision : 'decision'}`
  if (event.type === 'multi_agent.agent.completed') return `${typeof payload.name === 'string' ? payload.name : 'agent'} completed`
  if (event.type === 'multi_agent.completed') return 'Crew completed'

  return event.type
}

function getTone(event: RunEvent): Tone {
  const payload = event.payload ?? {}
  if (event.type.includes('failed') || payload.decision === 'retry') return 'error'
  if (event.type.includes('reflection')) return payload.decision === 'accept' ? 'success' : 'warning'
  if (event.type.includes('completed')) return 'success'
  if (event.type.includes('planned')) return 'warning'
  return 'info'
}

function readNestedString(source: JsonObject, path: string[]) {
  let current: unknown = source
  for (const key of path) {
    if (!current || typeof current !== 'object') return null
    current = (current as JsonObject)[key]
  }
  return typeof current === 'string' ? current : null
}

function readNumber(value: unknown) {
  return typeof value === 'number' ? value : 0
}

export function CrewTimeline({ events }: { events: RunEvent[] }) {
  const [selected, setSelected] = useState<TimelineItem | null>(null)

  const items = useMemo<TimelineItem[]>(() => {
    return events
      .filter(event => event.type.startsWith('multi_agent'))
      .filter(event => !event.type.match(/^multi_agent\.agent\.\d+\.(started|completed)$/))
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
      <div className="panel-card">
        <div className="empty-state">No crew events yet. Run a multi-agent workflow to see the timeline.</div>
      </div>
    )
  }

  return (
    <div className="timeline-shell">
      <div className="timeline-header">
        <h3>Crew timeline</h3>
        <span className="empty-state">{items.length} events</span>
      </div>

      {lanes.map(([agent, laneItems]) => (
        <div key={agent} className="timeline-lane">
          <div className="timeline-lane-head">
            <strong>{agent}</strong>
            <span className="empty-state">{laneItems.length} steps</span>
          </div>

          <div className="timeline-track">
            {laneItems.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelected(item)}
                className="timeline-card"
                data-tone={item.tone}
              >
                <div className="timeline-card-label">{item.label}</div>
                <div className="timeline-card-meta">{item.type}</div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {selected && (
        <div className="timeline-detail">
          <strong>{selected.label}</strong>
          <div className="timeline-card-meta" style={{ marginTop: 4 }}>{selected.agent} · {selected.type}</div>
          <pre className="mini-pre">{JSON.stringify(selected.payload, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}
