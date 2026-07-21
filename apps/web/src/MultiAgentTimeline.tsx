/**
 * Multi-agent run timeline — projects `multi_agent.*` event types from
 * `run_events` into per-agent lanes with tone-coloured chips. The web's
 * "Multi-agent timeline" tab consumes this view; the engine
 * (`packages/engine/src/node-registry.ts`) emits the matching event types.
 *
 * Used by `components/RightPanel.tsx` (the `multiAgent` tab) and
 * `components/RunWorkspace.tsx` (the inline Agents projection).
 *
 * Invariants:
 * - The event-type strings parsed here match the runtime emitter exactly.
 *   Renaming `multi_agent.agent.completed` (etc) without coordinating
 *   with `node-registry.ts` breaks this view silently.
 * - Pagination piggy-backs on the run-events cursor: the
 *   "Load older events" button calls `onLoadOlderEvents` and the parent
 *   merges the new page into the same `events` array.
 */

import { useMemo, useState } from 'react'
import { Layers3 } from 'lucide-react'
import type { JsonObject, RunEvent } from './types'
import { EmptyState } from './components/EmptyState'
import { useWorkflowStore } from './store'
import { useT } from './i18n'
import { t as runtimeT } from './i18n/runtime'

/** Phantom lanes shown in the empty timeline so the operator sees the four
 *  phases a team run will record before anything has run. Purely
 *  illustrative (aria-hidden); tone keys map to the real chip tones. */
const GHOST_PHASES = [
  { key: 'planning', tone: 'config' },
  { key: 'toolCall', tone: 'ai' },
  { key: 'reflection', tone: 'http' },
  { key: 'completion', tone: 'success' },
] as const

type Tone = 'info' | 'config' | 'tool' | 'success' | 'warning' | 'error'

/** Tones shown in the legend above the lanes, ordered by the agent lifecycle
 *  (plan → call a tool → reflect → finish, with failure / other last) so the
 *  colour-coded chips below read as a sequence rather than an arbitrary palette.
 *  Each entry maps 1:1 to a `data-tone` value `getTone` can emit. */
const LEGEND_TONES: readonly Tone[] = ['config', 'tool', 'warning', 'success', 'error', 'info']

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
  const fallbackTeam = runtimeT('multiAgent.defaultAgent') as string
  const fallbackWorkflow = runtimeT('multiAgent.defaultWorkflow') as string

  if (event.type === 'multi_agent.agent.started') return typeof payload.name === 'string' ? payload.name : fallbackTeam
  if (event.type === 'multi_agent.agent.completed') return typeof payload.name === 'string' ? payload.name : fallbackTeam
  if (typeof payload.name === 'string') return payload.name
  if (typeof payload.agent === 'string') return payload.agent

  const match = event.type.match(/^multi_agent\.agent\.(\d+)\./)
  // `agent_N` is an identifier (not a label) — keep English to stay
  // consistent with engine-emitted event types.
  if (match) return `agent_${Number(match[1]) + 1}`

  if (event.type.startsWith('multi_agent')) return fallbackTeam
  return fallbackWorkflow
}

function getLabel(event: RunEvent): string {
  const payload = event.payload ?? {}
  const defaultAgent = runtimeT('multiAgent.defaultAgentName') as string
  const defaultTool = runtimeT('multiAgent.defaultTool') as string
  const defaultDecision = runtimeT('multiAgent.defaultDecision') as string

  if (event.type === 'multi_agent.started') return runtimeT('multiAgent.teamStarted', { count: payload.count ?? 0 }) as string
  if (event.type === 'multi_agent.agent.started') {
    return runtimeT('multiAgent.agentStarted', { name: typeof payload.name === 'string' ? payload.name : defaultAgent }) as string
  }
  if (event.type.match(/^multi_agent\.agent\.\d+\.started$/)) {
    return runtimeT('multiAgent.agentStarted', { name: typeof payload.name === 'string' ? payload.name : defaultAgent }) as string
  }
  if (event.type.match(/^multi_agent\.agent\.\d+\.completed$/)) {
    return runtimeT('multiAgent.agentCompleted', { name: typeof payload.name === 'string' ? payload.name : defaultAgent }) as string
  }
  if (event.type.endsWith('.step.started')) return runtimeT('multiAgent.stepStarted', { step: readNumber(payload.iteration) + 1 }) as string
  if (event.type.endsWith('.step.planned')) return runtimeT('multiAgent.stepPlanned', { tool: readNestedString(payload, ['plan', 'tool']) ?? defaultTool }) as string
  if (event.type.endsWith('.tool.started')) return runtimeT('multiAgent.toolStarted', { tool: typeof payload.tool === 'string' ? payload.tool : defaultTool }) as string
  if (event.type.endsWith('.tool.completed')) return runtimeT('multiAgent.toolCompleted') as string
  if (event.type.includes('reflection')) {
    return runtimeT('multiAgent.reflection', { decision: typeof payload.decision === 'string' ? payload.decision : defaultDecision }) as string
  }
  if (event.type === 'multi_agent.agent.completed') {
    return runtimeT('multiAgent.agentCompleted', { name: typeof payload.name === 'string' ? payload.name : defaultAgent }) as string
  }
  if (event.type === 'multi_agent.completed') return runtimeT('multiAgent.teamCompleted') as string

  return event.type
}

function getTone(event: RunEvent): Tone {
  const payload = event.payload ?? {}
  if (event.type.includes('failed') || payload.decision === 'retry') return 'error'
  if (event.type.includes('reflection')) return payload.decision === 'accept' ? 'success' : 'warning'
  if (event.type.includes('completed')) return 'success'
  if (event.type.includes('planned')) return 'warning'
  // Lifecycle starts get a hue instead of collapsing to gray: tool calls
  // read cyan ("tool call" lane), team/step starts read cobalt ("planning").
  if (event.type.endsWith('.tool.started')) return 'tool'
  if (event.type.endsWith('.step.started') || event.type.endsWith('.started')) return 'config'
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

export type MultiAgentTimelineProps = {
  events: RunEvent[]
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
  /** Hide the local heading when a composing panel already owns the title. */
  showHeader?: boolean
}

/** Render the per-agent timeline with selectable items and "Load older events" support. */
export function MultiAgentTimeline({
  events,
  eventsHasMore,
  onLoadOlderEvents,
  showHeader = true,
}: MultiAgentTimelineProps) {
  const { t, i18n } = useT()
  const setActiveTab = useWorkflowStore(state => state.setActiveTab)
  const [selected, setSelected] = useState<TimelineItem | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const handleLoadOlder = onLoadOlderEvents
    ? async () => {
        setLoadingOlder(true)
        try {
          await onLoadOlderEvents()
        } finally {
          setLoadingOlder(false)
        }
      }
    : null

  // `getAgentName` and `getLabel` call `runtimeT` internally, so include
  // `i18n.language` in the dep array so the memo re-computes on locale switch.
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
  }, [events, i18n.language])

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
      <div className="we-card">
        <EmptyState
          icon={<Layers3 />}
          kicker={t('multiAgent.empty')}
          body={t('multiAgent.emptyHelper')}
          cta={{ label: t('multiAgent.emptyCta'), onClick: () => setActiveTab('copilot') }}
          testId="multi-agent-empty"
        />
        <ul className="we-ghost-lanes" aria-hidden="true">
          {GHOST_PHASES.map(phase => (
            <li key={phase.key} className="we-ghost-lane">
              <span className={`we-ghost-lane__phase we-ghost-lane__phase--${phase.tone}`}>
                {t(`multiAgent.phase.${phase.key}`)}
              </span>
              <span className="we-ghost-lane__bar" />
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className="timeline-shell">
      {showHeader && (
        <div className="timeline-header">
          <div>
            <h3>{t('multiAgent.heading')}</h3>
            <p className="helper-text">{t('multiAgent.headerHelper')}</p>
          </div>
          <span className="mode-pill mode-pill-neutral">{t('multiAgent.eventCount', { count: items.length })}</span>
        </div>
      )}

      <ul className="we-timeline-legend" aria-label={t('multiAgent.legend.label')}>
        {LEGEND_TONES.map(tone => (
          <li key={tone} className="we-timeline-legend__item">
            <span className="we-timeline-legend__swatch" data-tone={tone} aria-hidden="true" />
            {t(`multiAgent.legend.${tone}`)}
          </li>
        ))}
      </ul>

      {eventsHasMore && handleLoadOlder && (
        <button
          type="button"
          className="load-older-events"
          disabled={loadingOlder}
          onClick={handleLoadOlder}
        >
          {loadingOlder ? t('multiAgent.loading') : t('multiAgent.loadOlder')}
        </button>
      )}

      {lanes.map(([agent, laneItems]) => (
        <div key={agent} className="timeline-lane">
          <div className="timeline-lane-head">
            <strong>{agent}</strong>
            <span className="empty-state">{t('multiAgent.stepCount', { count: laneItems.length })}</span>
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
