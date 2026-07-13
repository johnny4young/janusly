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

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Activity, AlertCircle, Search } from 'lucide-react'

import { formatCompactDuration } from '../constants'
import { getResolvedLocale, tRunEvent, useT } from '../i18n'
import { getInterEventDeltaMs, getRunEventPresentation, sortRunEventsChronologically } from '../run-timeline'
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
}: {
  events: RunEvent[]
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
}) {
  const { t, i18n } = useT()
  const [query, setQuery] = useState('')
  const [pendingScrollKey, setPendingScrollKey] = useState<string | null>(null)
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null)

  const chronological = useMemo(() => sortRunEventsChronologically(events), [events])
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

  const jumpToFirstFailure = () => {
    if (!firstFailure) return
    setQuery('')
    setPendingScrollKey(eventKey(firstFailure))
  }

  const noEvents = timelineItems.length === 0
  const noMatches = !noEvents && filteredItems.length === 0

  return (
    <div className="we-reasoning-panel" data-testid="run-event-timeline">
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
                    {item.deltaMs !== null && (
                      <span aria-label={t('rightPanel.reasoning.deltaAria', { duration: formatCompactDuration(item.deltaMs) }) as string}>
                        +{formatCompactDuration(item.deltaMs)}
                      </span>
                    )}
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
