import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  History,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  Wrench,
} from 'lucide-react'

import {
  ACTIVITY_FILTERS,
  buildActivityFeed,
  countActivityFeed,
  filterActivityFeed,
  type ActivityFeedItem,
  type ActivityFilter,
} from '../activity-feed'
import { api } from '../api'
import { formatStatusLabel, getNodeLabel } from '../constants'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { useVirtualList } from '../hooks/useVirtualList'
import { getResolvedLocale, useT } from '../i18n'
import type { DeadLetter } from './dead-letter-types'
import { EmptyView } from './panel-primitives'
import {
  consumeRecoveryQueueFocus,
  parseRecoveryQueueFocusEvent,
  RECOVERY_QUEUE_FOCUS_EVENT,
  type RecoveryQueueFocusRequest,
} from './recovery-queue-focus-bus'
import type { RunWorkspaceProps } from './RunWorkspace'

const RunWorkspace = lazy(() => import('./RunWorkspace').then(module => ({
  default: module.RunWorkspace,
})))
const ActivityRecoveryDetail = lazy(() => import('./ActivityRecoveryDetail').then(module => ({
  default: module.ActivityRecoveryDetail,
})))

const ACTIVITY_ROW_HEIGHT = 110

type ActivitySelection =
  | { kind: 'run'; id: string }
  | { kind: 'recovery'; id: string }

export type ActivityWorkspaceProps = RunWorkspaceProps & {
  deadLetters: DeadLetter[]
  activeRecoveryId?: string | null
  onSelectRecovery: (id: string | null) => void
  onClearActiveRun: () => void
  onOpenRecoveryTools: () => void
  canReadDeadLetters?: boolean
}

function filterIcon(filter: ActivityFilter) {
  if (filter === 'running') return <Activity size={13} aria-hidden="true" />
  if (filter === 'needs_action') return <Clock3 size={13} aria-hidden="true" />
  if (filter === 'failed') return <AlertTriangle size={13} aria-hidden="true" />
  if (filter === 'recovered') return <CheckCircle2 size={13} aria-hidden="true" />
  return <ListChecks size={13} aria-hidden="true" />
}

function rowStatus(item: ActivityFeedItem): string {
  return item.kind === 'run' ? item.run.status : item.deadLetter.status
}

function activityTime(value: string | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getResolvedLocale())
}

function humanizeIdentifier(value: string): string {
  const compact = value.trim().replace(/[_./-]+/g, ' ').replace(/\s+/g, ' ')
  if (!compact) return value
  return compact.charAt(0).toUpperCase() + compact.slice(1)
}

function ActivityRow({
  item,
  selected,
  onSelect,
}: {
  item: ActivityFeedItem
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useT()
  const recovery = item.kind === 'recovery' ? item.deadLetter : null
  const workflowName = item.workflowName || t('activity.unknownWorkflow')
  const stepName = recovery
    ? recovery.nodeType
      ? getNodeLabel(recovery.nodeType)
      : humanizeIdentifier(recovery.nodeId)
    : null
  const status = rowStatus(item)
  const needsAction = item.category === 'needs_action'
  const displayedStatus = needsAction
    ? t('activity.filter.needs_action')
    : formatStatusLabel(status)
  const statusTone = needsAction ? 'waiting' : status

  return (
    <article
      className="list-card we-activity-row"
      data-selected={selected ? 'true' : 'false'}
      data-category={item.category}
      data-testid={`activity-row-${item.key}`}
    >
      <button
        type="button"
        className="list-card-row"
        aria-pressed={selected}
        onClick={onSelect}
        aria-label={t('activity.rowAria', {
          kind: t(`activity.kind.${item.kind}`),
          workflow: workflowName,
          status: displayedStatus,
          nextAction: t(`activity.nextAction.${item.nextAction}`),
        })}
      >
        <span className="we-activity-row__primary">
          <span className="we-activity-row__kind">
            {item.kind === 'run'
              ? <Activity size={14} aria-hidden="true" />
              : <ShieldAlert size={14} aria-hidden="true" />}
            {t(`activity.kind.${item.kind}`)}
          </span>
          <strong title={workflowName}>{workflowName}</strong>
          {stepName && <span title={recovery?.nodeId}>{stepName}</span>}
        </span>
        <span className="we-activity-row__status">
          <span className="status-pill" data-status={statusTone}>{displayedStatus}</span>
          <time dateTime={item.createdAt}>{activityTime(item.createdAt)}</time>
        </span>
        <span className="we-activity-row__next">
          {t(`activity.nextAction.${item.nextAction}`)}
        </span>
        <code title={item.runId}>{item.runId.slice(0, 8)}…</code>
      </button>
    </article>
  )
}

export function ActivityWorkspace({
  deadLetters,
  activeRecoveryId = null,
  onSelectRecovery,
  onClearActiveRun,
  onOpenRecoveryTools,
  canReadDeadLetters = true,
  ...runWorkspaceProps
}: ActivityWorkspaceProps) {
  const { t } = useT()
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [pendingRunId, setPendingRunId] = useState<string | null>(null)
  const [offListRecovery, setOffListRecovery] = useState<DeadLetter | null>(null)
  const [showDetailedHistory, setShowDetailedHistory] = useState(false)
  const feedHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const detailRef = useRef<HTMLElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const previousRunIdRef = useRef(runWorkspaceProps.activeRunId)
  const selectedRunId = pendingRunId ?? runWorkspaceProps.activeRunId
  const selection: ActivitySelection | null = activeRecoveryId
    ? { kind: 'recovery', id: activeRecoveryId }
    : selectedRunId
      ? { kind: 'run', id: selectedRunId }
      : null
  const selectionKey = selection ? `${selection.kind}:${selection.id}` : null
  const feed = useMemo(
    () => buildActivityFeed(runWorkspaceProps.runs, deadLetters, runWorkspaceProps.workflows),
    [deadLetters, runWorkspaceProps.runs, runWorkspaceProps.workflows],
  )
  const counts = useMemo(() => countActivityFeed(feed), [feed])
  const filtered = useMemo(() => filterActivityFeed(feed, filter), [feed, filter])
  const selectedItem = selection
    ? feed.find(item => item.kind === selection.kind && item.entityId === selection.id) ?? null
    : null
  const selectedRecovery = selection?.kind === 'recovery'
    ? deadLetters.find(item => item.id === selection.id) ?? offListRecovery
    : null
  const {
    containerRef,
    visibleItems,
    totalHeight,
    startOffset,
  } = useVirtualList({
    items: filtered,
    rowHeight: ACTIVITY_ROW_HEIGHT,
    resetScrollKey: filter,
  })

  useEffect(() => {
    if (!selectionKey) return
    const panel = detailRef.current
    if (!panel) return
    const bounds = panel.getBoundingClientRect()
    const offscreen = bounds.top >= window.innerHeight || bounds.bottom <= 0
    // Revealing detail is a courtesy, not a content dependency. Embedded or
    // simulated browsers without scrollIntoView must still retain the panel.
    if (offscreen && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({
        block: 'nearest',
        behavior: reducedMotion ? 'auto' : 'smooth',
      })
    }
    // Move assistive-technology context to the newly opened evidence without
    // adding another stop to the normal tab order.
    panel.focus({ preventScroll: true })
  }, [reducedMotion, selectionKey])

  const selectRun = useCallback((runId: string) => {
    setShowDetailedHistory(false)
    setPendingRunId(runId)
    onSelectRecovery(null)
    const opening = runWorkspaceProps.onOpenRun(runId)
    if (opening && typeof opening.then === 'function') {
      void opening.finally(() => {
        setPendingRunId(current => current === runId ? null : current)
      })
    }
  }, [onSelectRecovery, runWorkspaceProps.onOpenRun])

  const selectRecovery = useCallback((deadLetterId: string) => {
    setShowDetailedHistory(false)
    setPendingRunId(null)
    onSelectRecovery(deadLetterId)
    onClearActiveRun()
  }, [onClearActiveRun, onSelectRecovery])

  const adoptRecoveryRequest = useCallback((request: RecoveryQueueFocusRequest) => {
    setShowDetailedHistory(false)
    setPendingRunId(null)
    onClearActiveRun()
    if (request.deadLetterId) {
      setFilter('all')
      onSelectRecovery(request.deadLetterId)
      return
    }
    onSelectRecovery(null)
    setFilter('needs_action')
    requestAnimationFrame(() => feedHeadingRef.current?.focus())
  }, [onClearActiveRun, onSelectRecovery])

  useEffect(() => {
    const pending = consumeRecoveryQueueFocus()
    if (pending) adoptRecoveryRequest(pending)
    const onFocus = (event: Event) => {
      const request = consumeRecoveryQueueFocus() ?? parseRecoveryQueueFocusEvent(event)
      if (request) adoptRecoveryRequest(request)
    }
    window.addEventListener(RECOVERY_QUEUE_FOCUS_EVENT, onFocus)
    return () => window.removeEventListener(RECOVERY_QUEUE_FOCUS_EVENT, onFocus)
  }, [adoptRecoveryRequest])

  useEffect(() => {
    const activeRunId = runWorkspaceProps.activeRunId
    if (activeRunId && activeRunId !== previousRunIdRef.current) {
      setShowDetailedHistory(false)
      setPendingRunId(null)
    }
    previousRunIdRef.current = activeRunId
  }, [runWorkspaceProps.activeRunId])

  useEffect(() => {
    if (selection?.kind !== 'recovery') {
      setOffListRecovery(null)
      return
    }
    if (deadLetters.some(item => item.id === selection.id)) {
      setOffListRecovery(null)
      return
    }
    const controller = new AbortController()
    api(`/dlq?id=${encodeURIComponent(selection.id)}`, { signal: controller.signal })
      .then(value => {
        if (!controller.signal.aborted) setOffListRecovery(value as DeadLetter)
      })
      .catch(() => {
        if (!controller.signal.aborted) setOffListRecovery(null)
      })
    return () => controller.abort()
  }, [deadLetters, selection])

  if (showDetailedHistory) {
    return (
      <div
        className="we-activity-workspace"
        data-testid="activity-workspace"
        data-mode="run-history"
      >
        <div className="we-card split-row we-activity-advanced-banner">
          <div>
            <span className="section-kicker">{t('activity.advanced.kicker')}</span>
            <strong>{t('activity.advanced.runHistory')}</strong>
          </div>
          <button
            type="button"
            className="small-command"
            onClick={() => setShowDetailedHistory(false)}
          >
            {t('activity.advanced.back')}
          </button>
        </div>
        <div data-testid="activity-run-history">
          <Suspense fallback={<p className="helper-text">{t('common.working')}</p>}>
            <RunWorkspace {...runWorkspaceProps} />
          </Suspense>
        </div>
      </div>
    )
  }

  return (
    <div className="we-activity-workspace" data-testid="activity-workspace">
      <header className="we-card we-activity-header">
        <div className="we-activity-header__copy">
          <span className="section-kicker">{t('activity.kicker')}</span>
          <div>
            <h1>{t('activity.title')}</h1>
            <p>{t('activity.description')}</p>
          </div>
        </div>
        <div className="we-activity-header__tools">
          <button
            type="button"
            className="small-command"
            data-testid="activity-refresh"
            onClick={() => void runWorkspaceProps.onRefreshPlatform()}
          >
            <RefreshCw size={12} aria-hidden="true" />
            {t('common.refresh')}
          </button>
          <button
            type="button"
            className="small-command"
            data-testid="activity-open-run-history"
            onClick={() => {
              setPendingRunId(null)
              onSelectRecovery(null)
              setShowDetailedHistory(true)
            }}
          >
            <History size={12} aria-hidden="true" />
            {t('activity.advanced.runHistory')}
          </button>
          {canReadDeadLetters && (
            <button
              type="button"
              className="small-command"
              data-testid="activity-open-recovery-tools"
              onClick={onOpenRecoveryTools}
            >
              <Wrench size={12} aria-hidden="true" />
              {t('activity.advanced.recoveryTools')}
            </button>
          )}
        </div>
        <div
          className="we-activity-filters"
          role="group"
          aria-label={t('activity.filtersAria')}
        >
          {ACTIVITY_FILTERS.map(value => (
            <button
              key={value}
              type="button"
              className="small-command we-activity-filter"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              data-testid={`activity-filter-${value}`}
            >
              {filterIcon(value)}
              <span>{t(`activity.filter.${value}`)}</span>
              <strong>{counts[value]}</strong>
            </button>
          ))}
        </div>
      </header>

      <div className="we-activity-layout" data-has-detail={selection ? 'true' : 'false'}>
        <section className="we-card we-activity-feed">
          <div className="split-row we-activity-feed__heading">
            <div>
              <h2 ref={feedHeadingRef} tabIndex={-1}>{t('activity.feed.title')}</h2>
              <p>{t('activity.feed.description')}</p>
            </div>
            <span aria-live="polite">{t('activity.feed.count', { count: filtered.length })}</span>
          </div>

          {filtered.length === 0 ? (
            <EmptyView
              icon={<Activity size={22} />}
              title={t(feed.length === 0 ? 'activity.empty.title' : 'activity.noMatches.title')}
              body={t(feed.length === 0 ? 'activity.empty.body' : 'activity.noMatches.body')}
              cta={feed.length > 0 ? {
                label: t('activity.filter.all'),
                onClick: () => setFilter('all'),
              } : undefined}
            />
          ) : (
            <div
              ref={containerRef}
              className="we-activity-feed__list"
              data-testid="activity-feed-list"
              aria-label={t('activity.feed.listAria')}
            >
              <div style={{ height: totalHeight, position: 'relative' }}>
                <div style={{ transform: `translateY(${startOffset}px)` }}>
                  {visibleItems.map(({ item }) => (
                    <ActivityRow
                      key={item.key}
                      item={item}
                      selected={selectedItem?.key === item.key}
                      onSelect={() => {
                        if (item.kind === 'run') selectRun(item.entityId)
                        else selectRecovery(item.entityId)
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        {selection && (
          <aside
            ref={detailRef}
            tabIndex={-1}
            className="we-card we-activity-detail"
            data-testid="activity-detail"
          >
            <Suspense fallback={<p className="helper-text">{t('common.working')}</p>}>
              {selection.kind === 'run' ? (
                runWorkspaceProps.activeRunId === selection.id ? (
                  <RunWorkspace
                    {...runWorkspaceProps}
                    runsPanelVariant="activity-detail"
                  />
                ) : (
                  <p className="we-activity-detail__state" role="status">
                    {t('activity.runDetail.loading')}
                  </p>
                )
              ) : selectedRecovery ? (
                <ActivityRecoveryDetail
                  deadLetter={selectedRecovery}
                  initialDetail={selectedRecovery === offListRecovery
                    ? offListRecovery
                    : undefined}
                  onOpenRun={selectRun}
                  onReplay={runWorkspaceProps.onReplayDeadLetter}
                  onResolve={runWorkspaceProps.onResolveDeadLetter}
                  canReplay={runWorkspaceProps.canReplayDeadLetters}
                  canResolve={runWorkspaceProps.canResolveDeadLetters}
                  canStartRuns={runWorkspaceProps.canStartRuns}
                  canUseRecovery={runWorkspaceProps.canUseRecovery}
                />
              ) : (
                <p className="we-activity-detail__state" role="status">
                  {t('activity.recoveryDetail.loadingEvidence')}
                </p>
              )}
            </Suspense>
          </aside>
        )}
      </div>
    </div>
  )
}
