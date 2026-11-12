/** The Agent activity tab: the run's multi-agent timeline, or the agent sessions observed through hooks. */
import { lazy, Suspense, useEffect, useState } from 'react'

import { useT } from '../i18n'
import { onRouteChange, readRoute, writeRoute } from '../lib/route'
import { MultiAgentTimeline, type MultiAgentTimelineProps } from '../MultiAgentTimeline'
import { Button } from './ui/Button'
import './AgentActivityPanel.css'

const AgentSessionsPanel = lazy(() => import('./AgentSessionsPanel').then(m => ({ default: m.AgentSessionsPanel })))

export function AgentActivityPanel({ canReadSessions, onOpenRun, ...timeline }: MultiAgentTimelineProps & {
  canReadSessions: boolean
  onOpenRun?: (runId: string) => void
}) {
  const { t } = useT()
  const [sessions, setSessions] = useState(() => canReadSessions && readRoute()?.agentSessions === true)
  useEffect(() => onRouteChange(route => setSessions(canReadSessions && route?.agentSessions === true)), [canReadSessions])
  const show = (next: boolean) => {
    writeRoute(next ? { tab: 'multiAgent', agentSessions: true } : { tab: 'multiAgent' })
    setSessions(next)
  }
  return (
    <div className="agent-activity">
      {canReadSessions && (
        <div className="agent-activity__switch" role="group" aria-label={t('rightPanel.multiAgent.title')}>
          <Button size="sm" variant={sessions ? 'ghost' : 'secondary'} aria-pressed={!sessions} onClick={() => show(false)}>
            {t('agentSessions.tab.timeline')}
          </Button>
          <Button size="sm" variant={sessions ? 'secondary' : 'ghost'} aria-pressed={sessions} onClick={() => show(true)}>
            {t('agentSessions.tab.sessions')}
          </Button>
        </div>
      )}
      {sessions
        ? <Suspense fallback={<p className="helper-text">{t('common.loading')}</p>}><AgentSessionsPanel onOpenRun={onOpenRun} /></Suspense>
        : <MultiAgentTimeline {...timeline} />}
    </div>
  )
}
