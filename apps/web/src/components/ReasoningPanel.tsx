/**
 * Searchable, virtualized run-event timeline for long workflow executions.
 *
 * Used by:
 * - `apps/web/src/components/RightPanel.tsx` — the Reasoning workspace tab.
 *
 * Invariants:
 * - Events are projected chronologically before deltas are computed, then
 *   displayed newest-first.
 * - Fixed-height rows are required by `useVirtualList`; payload content scrolls
 *   inside its card instead of changing the virtual row pitch.
 * - Filter changes reset the local scroll, while loading older events preserves
 *   the operator's position.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, AlertCircle, GitCompareArrows, LoaderCircle, Search, X } from 'lucide-react'

import { formatCompactDuration } from '../constants'
import { getResolvedLocale, tApiError, tRunEvent, useT } from '../i18n'
import {
  getInterEventDeltaMs,
  getRunEventPresentation,
  parseCausalReplay,
  sortRunEventsChronologically,
  summarizeRunDiagnostics,
  type CausalReplay,
  type RunDiagnostics,
} from '../run-timeline'
import type { RunEvent } from '../types'
import { useVirtualList } from '../hooks/useVirtualList'
import { EmptyView } from './panel-primitives'

const RUN_EVENT_ROW_HEIGHT = 172

type TimelineItem = {
  key: string
  event: RunEvent
  deltaMs: number | null
  presentation: ReturnType<typeof getRunEventPresentation>
}

type CausalState =
  | { status: 'idle' }
  | { status: 'loading'; runId: string; eventKey: string; nodeId: string }
  | { status: 'ready'; runId: string; eventKey: string; nodeId: string; replay: CausalReplay }
  | { status: 'error'; runId: string; eventKey: string; nodeId: string; error: unknown; invalidResponse: boolean }

type CausalResponsePromise = Promise<unknown>
type ReplayDecision = (eventId: string, nodeId: string, signal: AbortSignal) => CausalResponsePromise

function eventKey(event: RunEvent): string {
  return event.id ?? `${event.type}:${event.nodeId ?? ''}:${event.createdAt ?? ''}`
}

function timelineItemKey(item: TimelineItem): string {
  return item.key
}

function isFailureEvent(event: RunEvent): boolean {
  return event.type === 'run.failed' || event.type.endsWith('.failed')
}

export function ReasoningPanel({
  events,
  eventsHasMore,
  onLoadOlderEvents,
  activeRunId,
  onReplayDecision,
}: {
  events: RunEvent[]
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
  activeRunId?: string | null
  onReplayDecision?: ReplayDecision
}) {
  const { t, i18n } = useT()
  const [query, setQuery] = useState('')
  const [pendingScrollKey, setPendingScrollKey] = useState<string | null>(null)
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null)
  const [causalState, setCausalState] = useState<CausalState>({ status: 'idle' })
  const causalRequestRef = useRef<{ generation: number; controller: AbortController } | null>(null)
  const causalTriggerRef = useRef<HTMLButtonElement | null>(null)

  const chronological = useMemo(() => sortRunEventsChronologically(events), [events])
  const diagnostics = useMemo(() => summarizeRunDiagnostics(events), [events])
  const timelineItems = useMemo<TimelineItem[]>(() => chronological.map((event, index) => ({
    key: eventKey(event),
    event,
    deltaMs: getInterEventDeltaMs(chronological[index - 1], event),
    presentation: getRunEventPresentation(event),
  })).reverse(), [chronological])
  const firstFailure = useMemo(() => chronological.find(isFailureEvent) ?? null, [chronological])
  const normalizedQuery = query.trim().toLocaleLowerCase(i18n.language)
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return timelineItems
    return timelineItems.filter(({ event }) => {
      let payload = ''
      try {
        payload = JSON.stringify(event.payload ?? '')
      } catch {
        // A malformed/non-serializable payload must not break local filtering.
      }
      const haystack = `${event.type} ${event.nodeId ?? ''} ${tRunEvent(event)} ${payload}`
        .toLocaleLowerCase(i18n.language)
      return haystack.includes(normalizedQuery)
    })
  }, [i18n.language, normalizedQuery, timelineItems])

  const {
    containerRef,
    visibleItems,
    totalHeight,
    startOffset,
    scrollToIndex,
  } = useVirtualList({
    items: filteredItems,
    rowHeight: RUN_EVENT_ROW_HEIGHT,
    resetScrollKey: normalizedQuery,
    getItemKey: timelineItemKey,
  })

  useEffect(() => {
    if (!pendingScrollKey || normalizedQuery) return
    const index = filteredItems.findIndex(item => item.key === pendingScrollKey)
    if (index === -1) return
    scrollToIndex(index, 'center')
    setPendingFocusKey(pendingScrollKey)
    setPendingScrollKey(null)
  }, [filteredItems, normalizedQuery, pendingScrollKey, scrollToIndex])

  useEffect(() => {
    if (!pendingFocusKey || !visibleItems.some(({ item }) => item.key === pendingFocusKey)) return
    const frame = requestAnimationFrame(() => {
      const target = [...(containerRef.current?.querySelectorAll<HTMLElement>('[data-event-key]') ?? [])]
        .find(element => element.dataset.eventKey === pendingFocusKey)
      target?.focus({ preventScroll: true })
      setPendingFocusKey(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [containerRef, pendingFocusKey, visibleItems])

  useEffect(() => {
    causalRequestRef.current?.controller.abort()
    causalRequestRef.current = null
    causalTriggerRef.current = null
    setCausalState({ status: 'idle' })
    return () => causalRequestRef.current?.controller.abort()
  }, [activeRunId])

  const inspectDecision = async (item: TimelineItem) => {
    const nodeId = item.event.nodeId
    const eventId = item.event.id
    if (!activeRunId || !eventId || !nodeId || item.event.type !== 'decision.made' || !onReplayDecision) return
    const runId = activeRunId
    causalRequestRef.current?.controller.abort()
    const controller = new AbortController()
    const generation = (causalRequestRef.current?.generation ?? 0) + 1
    causalRequestRef.current = { generation, controller }
    setCausalState({ status: 'loading', runId, eventKey: item.key, nodeId })
    try {
      const payload = await onReplayDecision(eventId, nodeId, controller.signal)
      if (controller.signal.aborted || causalRequestRef.current?.generation !== generation) return
      const replay = parseCausalReplay(payload)
      if (!replay) {
        setCausalState({ status: 'error', runId, eventKey: item.key, nodeId, error: null, invalidResponse: true })
        return
      }
      setCausalState({ status: 'ready', runId, eventKey: item.key, nodeId, replay })
    } catch (error) {
      if (controller.signal.aborted || causalRequestRef.current?.generation !== generation) return
      setCausalState({ status: 'error', runId, eventKey: item.key, nodeId, error, invalidResponse: false })
    }
  }

  const jumpToFirstFailure = () => {
    if (!firstFailure) return
    setQuery('')
    setPendingScrollKey(eventKey(firstFailure))
  }

  const noEvents = timelineItems.length === 0
  const noMatches = !noEvents && filteredItems.length === 0

  const visibleCausalState = causalState.status !== 'idle' && causalState.runId === activeRunId
    ? causalState
    : null

  return (
    <div className="we-reasoning-panel" data-testid="run-event-timeline">
      {!noEvents && (
        <RunDiagnosticsCard diagnostics={diagnostics} partial={Boolean(eventsHasMore)} />
      )}
      {visibleCausalState && (
        <CausalAnalysisCard
          state={visibleCausalState}
          onClose={() => {
            causalRequestRef.current?.controller.abort()
            causalRequestRef.current = null
            setCausalState({ status: 'idle' })
            requestAnimationFrame(() => causalTriggerRef.current?.focus())
          }}
        />
      )}
      <div className="we-reasoning-toolbar">
        <label className="we-reasoning-filter">
          <span>{t('rightPanel.reasoning.filterLabel')}</span>
          <span className="we-reasoning-filter__input">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('rightPanel.reasoning.filterPlaceholder') as string}
              data-testid="run-event-filter"
            />
          </span>
        </label>
        <div className="we-reasoning-toolbar__actions">
          <span className="helper-text">
            {t(
              eventsHasMore ? 'rightPanel.reasoning.loadedEventCount' : 'rightPanel.reasoning.eventCount',
              { visible: filteredItems.length, count: timelineItems.length },
            )}
          </span>
          <button
            type="button"
            className="command-button"
            disabled={!firstFailure}
            onClick={jumpToFirstFailure}
            title={eventsHasMore && !firstFailure
              ? t('rightPanel.reasoning.failureMayBeOlder') as string
              : undefined}
          >
            <AlertCircle size={14} aria-hidden="true" />
            {t(eventsHasMore
              ? 'rightPanel.reasoning.jumpToFirstLoadedFailure'
              : 'rightPanel.reasoning.jumpToFirstFailure')}
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="we-virtual-list we-reasoning-list"
        data-testid="run-event-virtual-list"
        role="list"
        aria-label={t('rightPanel.reasoning.timelineAria') as string}
      >
        {noEvents && (
          <EmptyView
            icon={<Activity size={22} />}
            title={t('rightPanel.reasoning.empty.title') as string}
            body={t('rightPanel.reasoning.empty.body') as string}
          />
        )}
        {noMatches && (
          <EmptyView
            icon={<Search size={22} />}
            title={t('rightPanel.reasoning.noMatches.title') as string}
            body={t(eventsHasMore
              ? 'rightPanel.reasoning.noMatches.loadedBody'
              : 'rightPanel.reasoning.noMatches.body') as string}
            cta={{
              label: t('rightPanel.reasoning.clearFilter') as string,
              onClick: () => setQuery(''),
            }}
          />
        )}
        {filteredItems.length > 0 && (
          <div className="we-reasoning-list__spacer" style={{ height: totalHeight }}>
            <div className="we-reasoning-list__window" style={{ transform: `translateY(${startOffset}px)` }}>
              {visibleItems.map(({ item, index }) => (
                <article
                  key={item.key}
                  tabIndex={-1}
                  role="listitem"
                  aria-label={`${tRunEvent(item.event)} — ${item.event.nodeId ?? (t('rightPanel.reasoning.runLabel') as string)}`}
                  aria-posinset={index + 1}
                  aria-setsize={filteredItems.length}
                  className="list-card we-run-event"
                  data-event-key={item.key}
                  data-tone={item.presentation.tone}
                  data-noise={item.presentation.noise ? 'true' : undefined}
                  data-testid={`run-event-${item.event.id}`}
                >
                  <div className="we-run-event__header">
                    <span className="we-run-event__tone" aria-hidden="true" />
                    <strong>{tRunEvent(item.event)}</strong>
                    {item.event.createdAt && (
                      <time className="we-run-event__time" dateTime={item.event.createdAt} title={item.event.createdAt}>
                        {new Date(item.event.createdAt).toLocaleString(getResolvedLocale(), { dateStyle: 'short', timeStyle: 'medium' })}
                      </time>
                    )}
                  </div>
                  <div className="we-run-event__meta">
                    <span>{item.event.nodeId ?? (t('rightPanel.reasoning.runLabel') as string)}</span>
                    <span className="we-run-event__meta-actions">
                      {item.deltaMs !== null && (
                        <span aria-label={t('rightPanel.reasoning.deltaAria', { duration: formatCompactDuration(item.deltaMs) }) as string}>
                          +{formatCompactDuration(item.deltaMs)}
                        </span>
                      )}
                      {activeRunId && onReplayDecision && item.event.type === 'decision.made' && item.event.id && item.event.nodeId && (
                        <button
                          type="button"
                          className="we-run-event__what-if"
                          aria-expanded={visibleCausalState?.eventKey === item.key}
                          aria-controls="run-causal-analysis"
                          onClick={event => {
                            causalTriggerRef.current = event.currentTarget
                            void inspectDecision(item)
                          }}
                        >
                          <GitCompareArrows size={12} aria-hidden="true" />
                          {t('rightPanel.reasoning.causal.action')}
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="we-run-event__body">
                    <ReasoningPayload payload={item.event.payload} />
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </div>
      {eventsHasMore && onLoadOlderEvents && <LoadOlderEventsButton onClick={onLoadOlderEvents} />}
    </div>
  )
}

function RunDiagnosticsCard({ diagnostics, partial }: { diagnostics: RunDiagnostics; partial: boolean }) {
  const { t } = useT()
  const locale = getResolvedLocale()
  const values = [
    { key: 'events', label: t('rightPanel.reasoning.diagnostics.events'), value: diagnostics.loadedEvents.toLocaleString(locale) },
    { key: 'span', label: t('rightPanel.reasoning.diagnostics.span'), value: diagnostics.observedDurationMs === null ? '—' : formatCompactDuration(diagnostics.observedDurationMs) },
    { key: 'retries', label: t('rightPanel.reasoning.diagnostics.retries'), value: diagnostics.retryCount.toLocaleString(locale) },
    { key: 'failures', label: t('rightPanel.reasoning.diagnostics.failures'), value: diagnostics.failedNodeCount.toLocaleString(locale) },
    { key: 'decisions', label: t('rightPanel.reasoning.diagnostics.decisions'), value: diagnostics.decisionCount.toLocaleString(locale) },
    { key: 'memory', label: t('rightPanel.reasoning.diagnostics.memory'), value: diagnostics.recalledEpisodeCount.toLocaleString(locale) },
  ]
  return (
    <section className="we-run-diagnostics" aria-label={t('rightPanel.reasoning.diagnostics.aria') as string} data-testid="run-diagnostics">
      <div className="we-run-diagnostics__heading">
        <div>
          <strong>{t(partial ? 'rightPanel.reasoning.diagnostics.loadedTitle' : 'rightPanel.reasoning.diagnostics.title')}</strong>
          <p>{t('rightPanel.reasoning.diagnostics.helper', { count: diagnostics.loadedEvents })}</p>
        </div>
        {partial && <span className="mode-pill mode-pill-neutral">{t('rightPanel.reasoning.diagnostics.partial')}</span>}
      </div>
      <dl className="we-run-diagnostics__grid">
        {values.map(item => (
          <div key={item.key}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function CausalAnalysisCard({ state, onClose }: { state: Exclude<CausalState, { status: 'idle' }>; onClose: () => void }) {
  const { t } = useT()
  const closeButton = (
    <button type="button" className="icon-button" onClick={onClose} aria-label={t('rightPanel.reasoning.causal.close') as string}>
      <X size={14} aria-hidden="true" />
    </button>
  )
  if (state.status === 'loading') {
    return (
      <section id="run-causal-analysis" className="we-causal-analysis" role="status" aria-live="polite" data-state="loading" data-testid="causal-analysis">
        <div className="we-causal-analysis__header">
          <span><LoaderCircle className="we-spin" size={16} aria-hidden="true" /> {t('rightPanel.reasoning.causal.loading', { nodeId: state.nodeId })}</span>
          {closeButton}
        </div>
      </section>
    )
  }
  if (state.status === 'error') {
    return (
      <section id="run-causal-analysis" className="we-causal-analysis" role="alert" data-state="error" data-testid="causal-analysis">
        <div className="we-causal-analysis__header">
          <span><AlertCircle size={16} aria-hidden="true" /> {t('rightPanel.reasoning.causal.errorTitle')}</span>
          {closeButton}
        </div>
        <p>{state.invalidResponse ? t('rightPanel.reasoning.causal.invalidResponse') : tApiError(state.error)}</p>
      </section>
    )
  }

  const chosenId = state.replay.chosen.nodeId
  const bestId = state.replay.best.nodeId
  const unchanged = chosenId === bestId
  return (
    <section id="run-causal-analysis" className="we-causal-analysis" data-state="ready" data-testid="causal-analysis" aria-label={t('rightPanel.reasoning.causal.resultAria', { nodeId: state.nodeId }) as string}>
      <div className="we-causal-analysis__header">
        <span><GitCompareArrows size={16} aria-hidden="true" /> {t('rightPanel.reasoning.causal.title', { nodeId: state.nodeId })}</span>
        {closeButton}
      </div>
      <p>{unchanged
        ? t('rightPanel.reasoning.causal.unchanged', { nodeId: chosenId })
        : t('rightPanel.reasoning.causal.changed', { chosenNodeId: chosenId, bestNodeId: bestId })}</p>
      <ol className="we-causal-ranking" aria-label={t('rightPanel.reasoning.causal.rankingAria') as string}>
        {state.replay.ranking.slice(0, 3).map((candidate, index) => (
          <li key={candidate.nodeId}>
            <span><strong>{index + 1}. {candidate.nodeId}</strong> · {t('rightPanel.reasoning.causal.score', { score: candidate.score.toFixed(3) })}</span>
            <span>{t('rightPanel.reasoning.causal.breakdown', {
              cost: candidate.breakdown.cost.toFixed(3),
              latency: formatCompactDuration(candidate.breakdown.latency),
              quality: `${Math.round(candidate.breakdown.quality * 100)}%`,
            })}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Render an event payload as labelled key/value rows with raw JSON on demand. */
function ReasoningPayload({ payload }: { payload?: RunEvent['payload'] }) {
  const { t } = useT()
  const entries = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.entries(payload as Record<string, unknown>)
    : []
  if (entries.length === 0) return null
  return (
    <>
      <dl className="we-reasoning-fields">
        {entries.map(([key, value]) => (
          <div key={key} className="we-reasoning-field">
            <dt>{key}</dt>
            <dd>{formatReasoningValue(value)}</dd>
          </div>
        ))}
      </dl>
      <details className="we-reasoning-raw">
        <summary>{t('rightPanel.reasoning.rawJson')}</summary>
        <pre className="mini-pre">{JSON.stringify(payload, null, 2)}</pre>
      </details>
    </>
  )
}

/** Primitive values stay readable; nested values use compact inline JSON. */
function formatReasoningValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return <span className="helper-text">—</span>
  if (typeof value === 'string') return value.length ? value : <span className="helper-text">—</span>
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return <code className="we-reasoning-field__json">{JSON.stringify(value)}</code>
}

function LoadOlderEventsButton({ onClick }: { onClick: () => void | Promise<void> }) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="load-older-events"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await onClick()
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? t('rightPanel.reasoning.loading') : t('rightPanel.reasoning.loadOlder')}
    </button>
  )
}
