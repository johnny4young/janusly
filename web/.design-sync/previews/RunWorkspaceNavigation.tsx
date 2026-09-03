import { RunWorkspaceNavigation } from '@janusly/web'

/**
 * The view switcher inside the run workspace. The event counts are shown on
 * the tabs, so a run with no agent activity reads differently from one with
 * a long multi-agent trace — and `hasActiveRun` decides whether there is
 * anything to switch between at all.
 */

/** A live run with both timelines populated. */
export function ActiveRun() {
  return (
    <RunWorkspaceNavigation
      activeView="overview"
      hasActiveRun
      eventCount={142}
      agentEventCount={38}
      onSelectView={() => {}}
      onOpenFullView={() => {}}
    />
  )
}

/** Sitting on the timeline view. */
export function TimelineSelected() {
  return (
    <RunWorkspaceNavigation
      activeView="timeline"
      hasActiveRun
      eventCount={142}
      agentEventCount={38}
      onSelectView={() => {}}
      onOpenFullView={() => {}}
    />
  )
}

/** A run with no agent steps — the agents tab has nothing to show. */
export function NoAgentActivity() {
  return (
    <RunWorkspaceNavigation
      activeView="agents"
      hasActiveRun
      eventCount={64}
      agentEventCount={0}
      onSelectView={() => {}}
      onOpenFullView={() => {}}
    />
  )
}

/** No run selected. */
export function NoActiveRun() {
  return (
    <RunWorkspaceNavigation
      activeView="overview"
      hasActiveRun={false}
      eventCount={0}
      agentEventCount={0}
      onSelectView={() => {}}
      onOpenFullView={() => {}}
    />
  )
}
