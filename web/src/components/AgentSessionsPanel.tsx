/**
 * Observed agent sessions: the list and one session's map, lanes nested
 * under their parent agent. A running session refreshes on a short poll.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Bot, CircleDot, CircleStop, Clock, RefreshCw } from 'lucide-react'

import { useAliveRef } from '../hooks/useAliveRef'
import { getResolvedLocale, useT } from '../i18n'
import {
  getAgentSessionMap,
  listAgentSessions,
  runtimeLabel,
  type AgentSessionMap,
  type AgentSessionSummary,
} from '../lib/agent-sessions'
import { onRouteChange, readRoute, writeRoute } from '../lib/route'
import { projectAgentLanes } from '../run-map'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { AgentLanes } from './RunAgentLanes'
import { Button } from './ui/Button'
import { StatusSummary } from './ui/StatusSummary'
import './AgentSessionsPanel.css'

export const SESSION_POLL_MS = 5000

const STATUS = {
  running: { icon: CircleDot, tone: 'info' },
  idle: { icon: Clock, tone: 'neutral' },
  ended: { icon: CircleStop, tone: 'neutral' },
} as const

function StatusPill({ status }: { status: AgentSessionSummary['status'] }) {
  const { t } = useT()
  const { icon: Icon, tone } = STATUS[status]
  return (
    <span className="we-pill" data-tone={tone} data-testid="agent-session-status">
      <Icon size={12} aria-hidden="true" /> {t(`agentSessions.status.${status}`)}
    </span>
  )
}

const when = (iso: string) => new Date(iso).toLocaleString(getResolvedLocale())

function sessionTitle(session: AgentSessionSummary, t: ReturnType<typeof useT>['t']): string {
  return session.project ?? t('agentSessions.unnamed', { id: session.id.slice(0, 8) })
}

function useRoutedSession(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(() => readRoute()?.agentSessionId ?? null)
  useEffect(() => onRouteChange(route => setId(route?.agentSessions ? route.agentSessionId ?? null : null)), [])
  const open = useCallback((next: string | null) => {
    writeRoute({ tab: 'multiAgent', agentSessions: true, ...(next ? { agentSessionId: next } : {}) })
    setId(next)
  }, [])
  return [id, open]
}

export function AgentSessionsPanel({ onOpenRun }: { onOpenRun?: (runId: string) => void }) {
  const [selected, open] = useRoutedSession()
  return selected
    ? <SessionDetail id={selected} onBack={() => open(null)} onOpenRun={onOpenRun} />
    : <SessionList onOpen={open} />
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useT()
  return (
    <StatusSummary role="alert" tone="danger" title={t('agentSessions.loadFailed')}
      actions={<Button size="sm" onClick={onRetry}>{t('common.retry')}</Button>} />
  )
}

function SessionList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useT()
  const alive = useAliveRef()
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (after: string | null) => {
    setLoading(true)
    setFailed(false)
    try {
      const page = await listAgentSessions(after)
      if (!alive.current) return
      setSessions(current => (after ? [...current, ...page.sessions] : page.sessions))
      setCursor(page.nextCursor)
    } catch {
      if (alive.current) setFailed(true)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [alive])

  useEffect(() => { void load(null) }, [load])

  return (
    <section className="agent-sessions" data-testid="agent-sessions">
      <Button size="sm" variant="ghost" className="agent-sessions__end" leadingIcon={<RefreshCw size={14} />}
        onClick={() => void load(null)} disabled={loading}>
        {t('common.refresh')}
      </Button>
      {failed && <LoadFailed onRetry={() => void load(null)} />}
      {loading && sessions.length === 0 && !failed && <LoadingSkeleton rows={3} label={t('common.loading')} />}
      {!loading && !failed && sessions.length === 0 && (
        <EmptyState icon={<Bot size={20} />} kicker={t('agentSessions.empty.title')} body={t('agentSessions.empty.body')} />
      )}
      {sessions.length > 0 && (
        <ul className="we-list" data-testid="agent-session-list">
          {sessions.map(session => (
            <li key={session.id} className="we-list-row">
              <Bot size={16} aria-hidden="true" />
              <div>
                <button type="button" className="agent-sessions__open" onClick={() => onOpen(session.id)}>
                  {sessionTitle(session, t)}
                </button>
                <p className="helper-text">
                  {[session.agentClientName, runtimeLabel(session.runtime), session.model].filter(Boolean).join(' · ')}
                  {' · '}<time dateTime={session.lastEventAt}>{when(session.lastEventAt)}</time>
                </p>
              </div>
              <StatusPill status={session.status} />
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button size="sm" onClick={() => void load(cursor)} loading={loading} loadingLabel={t('common.loading')}>
          {t('agentSessions.loadMore')}
        </Button>
      )}
    </section>
  )
}

function SessionDetail({ id, onBack, onOpenRun }: { id: string; onBack: () => void; onOpenRun?: (runId: string) => void }) {
  const { t } = useT()
  const alive = useAliveRef()
  const [map, setMap] = useState<AgentSessionMap | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await getAgentSessionMap(id)
      if (!alive.current) return
      setMap(next)
      setFailed(false)
    } catch {
      if (alive.current) setFailed(true)
    }
  }, [alive, id])

  useEffect(() => {
    setMap(null)
    void load()
  }, [load])
  const running = map?.session.status === 'running'
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => void load(), SESSION_POLL_MS)
    return () => clearInterval(timer)
  }, [load, running])

  const lanes = useMemo(() => projectAgentLanes((map?.lanes ?? []).map(lane =>
    lane.nodeId === 'main' ? { ...lane, agentType: t('agentSessions.mainAgent') } : lane)), [map, t])

  const back = (
    <Button size="sm" variant="ghost" className="agent-sessions__start" leadingIcon={<ArrowLeft size={14} />} onClick={onBack}>
      {t('agentSessions.back')}
    </Button>
  )
  if (!map) {
    return (
      <section className="agent-sessions">
        {back}
        {failed ? <LoadFailed onRetry={() => void load()} /> : <LoadingSkeleton rows={3} label={t('common.loading')} />}
      </section>
    )
  }
  const { session, totals, refs } = map
  return (
    <section className="agent-sessions" data-testid="agent-session-detail">
      {back}
      <header className="agent-sessions__head">
        <h3>{sessionTitle(session, t)}</h3>
        <StatusPill status={session.status} />
      </header>
      <p className="helper-text">
        {[session.agentClientName, runtimeLabel(session.runtime), session.model].filter(Boolean).join(' · ')}
        {' · '}<time dateTime={session.startedAt}>{when(session.startedAt)}</time>
      </p>
      <ul className="agent-sessions__totals" data-testid="agent-session-totals">
        <li>{t('agentSessions.events', { count: totals.events })}</li>
        <li>{t('agentSessions.toolCalls', { count: totals.toolCalls })}</li>
        <li>{t('agentSessions.mcpCalls', { count: totals.mcpCalls })}</li>
        {totals.errors > 0 && <li data-tone="danger">{t('agentSessions.errors', { count: totals.errors })}</li>}
      </ul>
      {onOpenRun && refs.runIds.length > 0 && (
        <div className="agent-sessions__refs" data-testid="agent-session-runs">
          {refs.runIds.map(runId => (
            <Button key={runId} size="sm" variant="ghost" onClick={() => onOpenRun(runId)}>
              {t('agentSessions.openRun', { id: runId.slice(0, 12) })}
            </Button>
          ))}
        </div>
      )}
      {session.truncated && <p className="helper-text" role="note">{t('agentSessions.truncated')}</p>}
      <AgentLanes lanes={lanes} testId="agent-session-lanes" />
    </section>
  )
}
