/**
 * Run inspection workspace for one active execution.
 *
 * Used by:
 * - `RightPanel.tsx` for the primary Runs destination.
 *
 * Invariants:
 * - Overview, Timeline, and Agents reuse the existing run projections; this
 *   component introduces no second data fetch or run authority path.
 * - The legacy Reasoning and Multi-agent tabs remain directly reachable from
 *   the command palette and the explicit "full view" action.
 * - Changing the active run resets to Overview so controls for a prior run
 *   cannot remain visually selected against a new identity.
 */

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Activity, ExternalLink, Layers3, ListChecks } from 'lucide-react'

import type { RunEvent } from '../types'
import { useT } from '../i18n'
import { PanelChrome } from './panel-primitives'
import { RunsPanel, type RunsPanelProps } from './RunsPanel'

const ReasoningPanel = lazy(() => import('./ReasoningPanel').then(module => ({ default: module.ReasoningPanel })))
const MultiAgentTimeline = lazy(() => import('../MultiAgentTimeline').then(module => ({ default: module.MultiAgentTimeline })))

export type RunWorkspaceView = 'overview' | 'timeline' | 'agents'

type LoadRunUsage = (runId: string, signal: AbortSignal) => Promise<unknown>
type ReplayDecision = (eventId: string, nodeId: string, signal: AbortSignal) => Promise<unknown>

export type RunWorkspaceProps = Omit<RunsPanelProps, 'mode' | 'onViewTimeline'> & {
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
  onOpenFullView: (tab: 'reasoning' | 'multiAgent') => void
  onLoadRunUsage?: LoadRunUsage
  onReplayDecision?: ReplayDecision
}

const VIEW_ORDER: readonly RunWorkspaceView[] = ['overview', 'timeline', 'agents']

function countAgentEvents(events: RunEvent[]): number {
  return events.filter(event => event.type.startsWith('multi_agent.')).length
}

export type RunWorkspaceNavigationProps = {
  activeView: RunWorkspaceView
  hasActiveRun: boolean
  eventCount: number
  agentEventCount: number
  onSelectView: (view: RunWorkspaceView) => void
  onOpenFullView: (tab: 'reasoning' | 'multiAgent') => void
}

/** Accessible inner navigation shared by the Runs workspace and browser tests. */
export function RunWorkspaceNavigation({
  activeView,
  hasActiveRun,
  eventCount,
  agentEventCount,
  onSelectView,
  onOpenFullView,
}: RunWorkspaceNavigationProps) {
  const { t } = useT()
  const tabRefs = useRef<Partial<Record<RunWorkspaceView, HTMLButtonElement | null>>>({})

  const selectView = (nextView: RunWorkspaceView, focus = false) => {
    if (nextView !== 'overview' && !hasActiveRun) return
    onSelectView(nextView)
    if (focus) requestAnimationFrame(() => tabRefs.current[nextView]?.focus())
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const availableViews = hasActiveRun ? VIEW_ORDER : VIEW_ORDER.slice(0, 1)
    const currentIndex = availableViews.indexOf(activeView)
    let nextIndex = currentIndex
    if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = availableViews.length - 1
    else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % availableViews.length
    else nextIndex = (currentIndex - 1 + availableViews.length) % availableViews.length
    const nextView = availableViews[nextIndex]
    if (nextView) selectView(nextView, true)
  }

  const tabLabel = (tab: RunWorkspaceView): string => {
    if (tab === 'timeline') return t('runWorkspace.tab.timelineAria', { count: eventCount })
    if (tab === 'agents') return t('runWorkspace.tab.agentsAria', { count: agentEventCount })
    return t('runWorkspace.tab.overview')
  }

  return (
    <header className="we-card we-run-workspace__navigation">
      <div className="we-run-workspace__heading">
        <span className="section-kicker">{t('runWorkspace.kicker')}</span>
        <div>
          <h2>{t('runWorkspace.title')}</h2>
          <p>{t('runWorkspace.description')}</p>
        </div>
      </div>

      <div className="we-run-workspace__controls">
        <div className="we-run-workspace__tabs" role="tablist" aria-label={t('runWorkspace.tabsAria')}>
          {VIEW_ORDER.map(tab => {
            const selected = activeView === tab
            const disabled = tab !== 'overview' && !hasActiveRun
            const count = tab === 'timeline' ? eventCount : tab === 'agents' ? agentEventCount : null
            const Icon = tab === 'overview' ? ListChecks : tab === 'timeline' ? Activity : Layers3
            return (
              <button
                key={tab}
                ref={element => { tabRefs.current[tab] = element }}
                type="button"
                role="tab"
                id={`run-workspace-tab-${tab}`}
                aria-controls={`run-workspace-panel-${tab}`}
                aria-selected={selected}
                aria-label={tabLabel(tab)}
                tabIndex={selected ? 0 : -1}
                disabled={disabled}
                className="we-run-workspace__tab"
                data-testid={`run-workspace-tab-${tab}`}
                onClick={() => selectView(tab)}
                onKeyDown={handleTabKeyDown}
              >
                <Icon size={14} aria-hidden="true" />
                {t(`runWorkspace.tab.${tab}`)}
                {count !== null && <span aria-hidden="true">{count}</span>}
              </button>
            )
          })}
        </div>

        {activeView !== 'overview' && (
          <button
            type="button"
            className="small-command we-run-workspace__full-view"
            onClick={() => onOpenFullView(activeView === 'timeline' ? 'reasoning' : 'multiAgent')}
          >
            <ExternalLink size={13} aria-hidden="true" />
            {activeView === 'timeline'
              ? t('runWorkspace.openFullTimeline')
              : t('runWorkspace.openFullAgents')}
          </button>
        )}
      </div>
    </header>
  )
}

/** Primary Runs destination with accessible, keyboard-navigable inner views. */
export function RunWorkspace({
  onOpenFullView,
  onLoadRunUsage,
  onReplayDecision,
  eventsHasMore,
  onLoadOlderEvents,
  ...runsProps
}: RunWorkspaceProps) {
  const { t } = useT()
  const [selection, setSelection] = useState<{
    runId: string | null | undefined
    view: RunWorkspaceView
  }>({ runId: runsProps.activeRunId, view: 'overview' })
  const events = runsProps.runEvents ?? []
  const agentEventCount = useMemo(() => countAgentEvents(events), [events])
  const hasActiveRun = Boolean(runsProps.activeRunId)
  const effectiveView = hasActiveRun && selection.runId === runsProps.activeRunId
    ? selection.view
    : 'overview'

  useEffect(() => {
    if (selection.runId === runsProps.activeRunId) return
    setSelection({ runId: runsProps.activeRunId, view: 'overview' })
  }, [runsProps.activeRunId, selection.runId])

  const selectView = (nextView: RunWorkspaceView) => {
    if (nextView !== 'overview' && !hasActiveRun) return
    setSelection({ runId: runsProps.activeRunId, view: nextView })
  }

  return (
    <div className="we-run-workspace" data-testid="run-workspace">
      <RunWorkspaceNavigation
        activeView={effectiveView}
        hasActiveRun={hasActiveRun}
        eventCount={events.length}
        agentEventCount={agentEventCount}
        onSelectView={selectView}
        onOpenFullView={onOpenFullView}
      />

      {VIEW_ORDER.map(panelView => (
        <section
          key={panelView}
          id={`run-workspace-panel-${panelView}`}
          role="tabpanel"
          aria-labelledby={`run-workspace-tab-${panelView}`}
          className="we-run-workspace__panel"
          data-testid={`run-workspace-panel-${panelView}`}
          hidden={effectiveView !== panelView}
        >
          {effectiveView === 'overview' && panelView === 'overview' && (
            <RunsPanel {...runsProps} onViewTimeline={() => selectView('timeline')} />
          )}
          {effectiveView === 'timeline' && panelView === 'timeline' && (
            <Suspense fallback={<p className="helper-text">{t('common.working')}</p>}>
              <PanelChrome
                title={t('rightPanel.reasoning.title')}
                description={t('rightPanel.reasoning.description')}
                icon={<Activity size={18} />}
              >
                <ReasoningPanel
                  events={events}
                  eventsHasMore={eventsHasMore}
                  onLoadOlderEvents={onLoadOlderEvents}
                  activeRunId={runsProps.activeRunId}
                  onLoadRunUsage={onLoadRunUsage}
                  onReplayDecision={onReplayDecision}
                />
              </PanelChrome>
            </Suspense>
          )}
          {effectiveView === 'agents' && panelView === 'agents' && (
            <Suspense fallback={<p className="helper-text">{t('common.working')}</p>}>
              <PanelChrome
                title={t('rightPanel.multiAgent.title')}
                description={t('rightPanel.multiAgent.description')}
                icon={<Layers3 size={18} />}
              >
                <MultiAgentTimeline
                  events={events}
                  eventsHasMore={eventsHasMore}
                  onLoadOlderEvents={onLoadOlderEvents}
                  showHeader={false}
                />
              </PanelChrome>
            </Suspense>
          )}
        </section>
      ))}
    </div>
  )
}
