/**
 * One run sheet: `RunsPanel` owns identity and actions, this component the tabs.
 *
 * Used by:
 * - `ActivityWorkspace.tsx` for the run detail and the detailed run history.
 *
 * Invariants:
 * - Every tab reuses the loaded run projections, except Agents, which reads
 *   the run map feed the canvas shares; there is no second authority path.
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
import { ExternalLink } from 'lucide-react'

import type { RunEvent } from '../types'
import { useT } from '../i18n'
import { PanelChrome } from './panel-primitives'
import { RerunStepDialog, RunExplainChat, RunsPanel, type RunsPanelProps } from './RunsPanel'
import './RunWorkspace.css'
import { Button } from './ui/Button'

const ReasoningPanel = lazy(() => import('./ReasoningPanel').then(module => ({ default: module.ReasoningPanel })))
const RunAgentLanes = lazy(() => import('./RunAgentLanes').then(module => ({ default: module.RunAgentLanes })))
const RunStepTimeline = lazy(() => import('./RunStepTimeline').then(module => ({ default: module.RunStepTimeline })))

export type RunWorkspaceView = 'overview' | 'timeline' | 'events' | 'agents' | 'ask'

type LoadRunUsage = (runId: string, signal: AbortSignal) => Promise<unknown>
type ReplayDecision = (eventId: string, nodeId: string, signal: AbortSignal) => Promise<unknown>

export type RunWorkspaceProps = Omit<
  RunsPanelProps,
  'mode' | 'renderSheet' | 'variant'
> & {
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
  onOpenFullView: (tab: 'reasoning' | 'multiAgent') => void
  onLoadRunUsage?: LoadRunUsage
  onReplayDecision?: ReplayDecision
  runsPanelVariant?: RunsPanelProps['variant']
}

const VIEW_ORDER: readonly RunWorkspaceView[] = ['overview', 'timeline', 'events', 'agents', 'ask']
const EMPTY_RUN_EVENTS: RunEvent[] = []

function countAgentEvents(events: RunEvent[]): number {
  return events.filter(event => event.type.startsWith('agent.') || event.type.startsWith('multi_agent.')).length
}

export type RunWorkspaceNavigationProps = {
  activeView: RunWorkspaceView
  hasActiveRun: boolean
  stepCount: number
  eventCount: number
  agentEventCount: number
  onSelectView: (view: RunWorkspaceView) => void
  onOpenFullView: (tab: 'reasoning' | 'multiAgent') => void
}

/** Accessible inner navigation shared by the Runs workspace and browser tests. */
export function RunWorkspaceNavigation({
  activeView,
  hasActiveRun,
  stepCount,
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

  const counts: Partial<Record<RunWorkspaceView, number>> = {
    timeline: stepCount,
    events: eventCount,
    agents: agentEventCount,
  }
  const fullView = activeView === 'agents'
    ? 'multiAgent'
    : activeView === 'timeline' || activeView === 'events' ? 'reasoning' : null
  const fullViewLabel = t(fullView === 'multiAgent' ? 'runWorkspace.openFullAgents' : 'runWorkspace.openFullTimeline')

  return (
    <div className="we-run-workspace__controls">
      <div className="we-run-workspace__tabs" role="tablist" aria-label={t('runWorkspace.tabsAria')}>
        {VIEW_ORDER.map(tab => {
          const selected = activeView === tab
          const count = counts[tab]
          return (
            <button
              key={tab}
              ref={element => { tabRefs.current[tab] = element }}
              type="button"
              role="tab"
              id={`run-workspace-tab-${tab}`}
              aria-controls={`run-workspace-panel-${tab}`}
              aria-selected={selected}
              aria-label={count === undefined ? undefined : t(`runWorkspace.tab.${tab}Aria`, { count })}
              tabIndex={selected ? 0 : -1}
              disabled={tab !== 'overview' && !hasActiveRun}
              className="we-run-workspace__tab"
              data-testid={`run-workspace-tab-${tab}`}
              onClick={() => selectView(tab)}
              onKeyDown={handleTabKeyDown}
            >
              {t(`runWorkspace.tab.${tab}`)}
              {count !== undefined && <span aria-hidden="true">{count}</span>}
            </button>
          )
        })}
      </div>

      {fullView && (
        <Button
          size="icon"
          variant="ghost"
          aria-label={fullViewLabel}
          title={fullViewLabel}
          data-testid="run-workspace-full-view"
          onClick={() => onOpenFullView(fullView)}
        >
          <ExternalLink size={13} aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}

/** Run sheet with accessible, keyboard-navigable tabs. */
export function RunWorkspace({
  onOpenFullView,
  onLoadRunUsage,
  onReplayDecision,
  eventsHasMore,
  onLoadOlderEvents,
  runsPanelVariant,
  ...runsProps
}: RunWorkspaceProps) {
  const { t } = useT()
  const { activeRunId } = runsProps
  const [selection, setSelection] = useState<{
    runId: string | null | undefined
    view: RunWorkspaceView
    askOpened?: boolean
  }>({ runId: activeRunId, view: 'overview' })
  const events = runsProps.runEvents ?? EMPTY_RUN_EVENTS
  const agentEventCount = useMemo(() => countAgentEvents(events), [events])
  const stepCount = useMemo(() => new Set([
    ...runsProps.runNodes.map(node => node.nodeId),
    ...events.flatMap(event => event.nodeId ?? []),
  ]).size, [events, runsProps.runNodes])
  const hasActiveRun = Boolean(activeRunId)
  const currentSelection = hasActiveRun && selection.runId === activeRunId ? selection : null
  const effectiveView = currentSelection?.view ?? 'overview'

  useEffect(() => {
    if (selection.runId === activeRunId) return
    setSelection({ runId: activeRunId, view: 'overview' })
  }, [activeRunId, selection.runId])

  const selectView = (nextView: RunWorkspaceView) => {
    if (nextView !== 'overview' && !hasActiveRun) return
    setSelection(current => ({
      runId: activeRunId,
      view: nextView,
      askOpened: nextView === 'ask' || current.askOpened,
    }))
  }

  const panelProps = (view: RunWorkspaceView) => ({
    id: `run-workspace-panel-${view}`,
    role: 'tabpanel',
    'aria-labelledby': `run-workspace-tab-${view}`,
    'data-testid': `run-workspace-panel-${view}`,
    hidden: effectiveView !== view,
  })
  const fallback = <p className="helper-text">{t('common.working')}</p>

  // Built here, not in renderSheet, so the sheet's one-second clock leaves them alone.
  const navigation = (
    <RunWorkspaceNavigation
      activeView={effectiveView}
      hasActiveRun={hasActiveRun}
      stepCount={stepCount}
      eventCount={events.length}
      agentEventCount={agentEventCount}
      onSelectView={selectView}
      onOpenFullView={onOpenFullView}
    />
  )
  const panels = (
    <>
      <section {...panelProps('timeline')}>
        {effectiveView === 'timeline' && (
          <Suspense fallback={fallback}>
            <RunStepTimeline
              events={events}
              nodes={runsProps.runNodes}
              eventsHasMore={eventsHasMore}
              onLoadOlderEvents={onLoadOlderEvents}
              run={runsProps.runs.find(run => run.id === activeRunId)}
              RerunDialog={runsProps.canStartRuns === false ? undefined : RerunStepDialog}
            />
          </Suspense>
        )}
      </section>
      <section {...panelProps('events')}>
        {effectiveView === 'events' && (
          <Suspense fallback={fallback}>
            <PanelChrome
              title={t('rightPanel.reasoning.title')}
              description={t('rightPanel.reasoning.description')}
            >
              <ReasoningPanel
                events={events}
                eventsHasMore={eventsHasMore}
                onLoadOlderEvents={onLoadOlderEvents}
                activeRunId={activeRunId}
                onLoadRunUsage={onLoadRunUsage}
                onReplayDecision={onReplayDecision}
              />
            </PanelChrome>
          </Suspense>
        )}
      </section>
      <section {...panelProps('agents')}>
        {effectiveView === 'agents' && activeRunId && (
          <Suspense fallback={fallback}>
            <PanelChrome
              title={t('rightPanel.multiAgent.title')}
              description={t('rightPanel.multiAgent.description')}
            >
              <RunAgentLanes runId={activeRunId} />
            </PanelChrome>
          </Suspense>
        )}
      </section>
      {/* Stays mounted once opened: the conversation survives a look at another tab. */}
      <section {...panelProps('ask')}>
        {currentSelection?.askOpened && <RunExplainChat runId={activeRunId} />}
      </section>
    </>
  )

  return (
    <div className="we-run-workspace" data-testid="run-workspace">
      <RunsPanel
        {...runsProps}
        variant={runsPanelVariant}
        renderSheet={({ header, overview }) => (
          <>
            <header className="we-card we-run-sheet">
              {header}
              {navigation}
            </header>
            <section {...panelProps('overview')}>
              {effectiveView === 'overview' && overview}
            </section>
            {panels}
          </>
        )}
      />
    </div>
  )
}
