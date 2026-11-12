/**
 * Observed agent sessions: the list and one session's map, lanes nested
 * under their parent agent. A running session refreshes on a short poll.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Bot, CircleDot, CircleStop, Clock, RefreshCw, Workflow } from 'lucide-react'

import { useAliveRef } from '../hooks/useAliveRef'
import { getResolvedLocale, useT } from '../i18n'
import {
  decideAgentGate,
  getAgentSessionMap,
  saveAgentSessionAsDraft,
  listAgentSessions,
  runtimeLabel,
  type AgentSessionDraft,
  type AgentSessionGate,
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
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load()
    }, SESSION_POLL_MS)
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
      {map.gates.length > 0 && <SessionGates gates={map.gates} onDecided={() => void load()} />}
      <SaveAsWorkflow sessionId={session.id} conversion={map.conversion} allowed={map.canConvert} />
      {session.truncated && <p className="helper-text" role="note">{t('agentSessions.truncated')}</p>}
      <AgentLanes lanes={lanes} testId="agent-session-lanes" />
    </section>
  )
}

/** Tool calls the agent's hook is holding. Without captured input the decider sees only the tool, and the card says so. */
function SessionGates({ gates, onDecided }: { gates: readonly AgentSessionGate[]; onDecided: () => void }) {
  const { t } = useT()
  const alive = useAliveRef()
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const decide = async (id: string, decision: 'approve' | 'deny') => {
    setBusy(id)
    setFailed(false)
    try {
      await decideAgentGate(id, decision)
    } catch {
      if (alive.current) setFailed(true)
    } finally {
      if (alive.current) setBusy(null)
      onDecided()
    }
  }

  return (
    <section className="agent-sessions__gates" aria-labelledby="agent-session-gates-title" data-testid="agent-session-gates">
      <h4 id="agent-session-gates-title">{t('agentSessions.gate.title')}</h4>
      {failed && <p role="alert" className="helper-text">{t('agentSessions.gate.failed')}</p>}
      <ul>
        {gates.map(gate => (
          <li key={gate.id} className="we-card agent-sessions__gate" data-testid="agent-session-gate">
            <code>{gate.tool}</code>
            {gate.input != null && <pre tabIndex={0}>{JSON.stringify(gate.input, null, 2)}</pre>}
            {!gate.contentCaptured && <p className="helper-text">{t('agentSessions.gate.notCaptured')}</p>}
            {gate.needsYou ? (
              <div className="agent-sessions__refs">
                <Button size="sm" variant="primary" loading={busy === gate.id} disabled={busy !== null}
                  onClick={() => void decide(gate.id, 'approve')}>{t('rightPanel.runs.toolApproval.approve')}</Button>
                <Button size="sm" variant="danger" disabled={busy !== null}
                  onClick={() => void decide(gate.id, 'deny')}>{t('rightPanel.runs.toolApproval.deny')}</Button>
              </div>
            ) : <p className="helper-text">{t('agentSessions.gate.cannotDecide')}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Says how much of the session a workflow can hold before converting: only MCP
 * tool calls become steps. The result is a draft with open placeholders.
 */
function SaveAsWorkflow({ sessionId, conversion, allowed }: {
  sessionId: string
  conversion: AgentSessionMap['conversion']
  allowed: boolean
}) {
  const { t } = useT()
  const alive = useAliveRef()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<AgentSessionDraft | null>(null)
  const [failed, setFailed] = useState(false)

  const save = async () => {
    setSaving(true)
    setFailed(false)
    try {
      const draft = await saveAgentSessionAsDraft(sessionId)
      if (alive.current) setSaved(draft)
    } catch {
      if (alive.current) setFailed(true)
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  return (
    <section className="we-card agent-sessions__convert" data-testid="agent-session-convert">
      <p>
        {conversion.convertible
          ? t('agentSessions.convert.summary', { convertible: conversion.convertibleSteps, total: conversion.totalSteps })
          : t('agentSessions.convert.none')}
      </p>
      {saved ? (
        <p role="status" data-testid="agent-session-draft">
          {t('agentSessions.convert.saved', { count: saved.placeholders.length })} <code>{saved.draftId}</code>
        </p>
      ) : allowed && conversion.convertible && (
        <Button size="sm" leadingIcon={<Workflow size={14} aria-hidden="true" />} loading={saving} loadingLabel={t('common.working')}
          onClick={() => void save()}>
          {t('agentSessions.convert.action')}
        </Button>
      )}
      {failed && <p role="alert" className="helper-text">{t('agentSessions.convert.failed')}</p>}
    </section>
  )
}
