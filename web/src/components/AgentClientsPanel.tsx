/**
 * Settings > Access: the organization's external agent clients. A token is
 * held in component state only while its dialog is open, never in a list or
 * the store. Rotate is offered to the creator; revoke to the creator or an admin.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Ban, Bot, CalendarX, CheckCircle2, ChevronDown, ChevronRight, Clock, LockKeyhole, RefreshCw, ShieldAlert, UserX } from 'lucide-react'

import { contractApi, isForbiddenApiError } from '../api'
import { tApiError, useT } from '../i18n'
import type { ApiResponse } from '../lib/api-types.generated'
import { isGetAgentClientsResponse } from '../lib/api-guards/operations/GetAgentClients'
import { isPostAgentClientsIdRevokeResponse } from '../lib/api-guards/operations/PostAgentClientsIdRevoke'
import { isPostAgentClientsIdRotateResponse } from '../lib/api-guards/operations/PostAgentClientsIdRotate'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { useWorkflowStore } from '../store'
import { actorLabel, formatWhen, useMemberEmails, useViewer } from './agent-actors'
import { useConfirm } from './ConfirmDialog'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Button } from './ui/Button'
import './AgentClientsPanel.css'

const loadDialogs = () => import('./AgentClientDialogs')
const CreateAgentClientDialog = lazy(() => loadDialogs().then((module) => ({ default: module.CreateAgentClientDialog })))
const AgentTokenDialog = lazy(() => loadDialogs().then((module) => ({ default: module.AgentTokenDialog })))
const AgentClientDetail = lazy(() => loadDialogs().then((module) => ({ default: module.AgentClientDetail })))

type AgentClientList = ApiResponse<'GET /agent-clients'>
type AgentClient = AgentClientList['clients'][number]
type IssuedAgentClient = ApiResponse<'POST /agent-clients'>
type Load = { kind: 'loading' } | { kind: 'forbidden' } | { kind: 'error'; message: string } | { kind: 'ready'; data: AgentClientList }

const AGENT_CLIENT_TAGS = [PLATFORM_TAG, 'agent-clients'] as const
const AGENT_CLIENT_MUTATION_TAGS = ['agent-clients'] as const
const EXPIRING_MS = 7 * 24 * 60 * 60 * 1000

export type AgentClientState = 'active' | 'expiring' | 'expired' | 'revoked' | 'removed' | 'reduced'

/** One state per row, most severe first; the server already enforces each. */
export function agentClientState(client: AgentClient, now = Date.now()): AgentClientState {
  if (client.status === 'revoked') return 'revoked'
  if (client.status === 'expired') return 'expired'
  if (client.creatorAccess.state === 'removed') return 'removed'
  if (client.creatorAccess.state === 'reduced') return 'reduced'
  const expiresAt = Date.parse(client.expiresAt)
  if (Number.isFinite(expiresAt) && expiresAt - now <= EXPIRING_MS) return 'expiring'
  return 'active'
}

const STATE_ICON: Record<AgentClientState, ReactNode> = {
  active: <CheckCircle2 size={13} aria-hidden="true" />,
  expiring: <Clock size={13} aria-hidden="true" />,
  expired: <CalendarX size={13} aria-hidden="true" />,
  revoked: <Ban size={13} aria-hidden="true" />,
  removed: <UserX size={13} aria-hidden="true" />,
  reduced: <ShieldAlert size={13} aria-hidden="true" />,
}

const STATE_TONE: Record<AgentClientState, string> = {
  active: 'success', expiring: 'warning', expired: 'neutral', revoked: 'neutral', removed: 'danger', reduced: 'warning',
}

export function AgentClientsPanel({ canWrite: permitted, canReadMembers }: { canWrite: boolean; canReadMembers: boolean }) {
  const { t } = useT()
  const confirm = useConfirm()
  const addToast = useWorkflowStore((state) => state.addToast)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const nonce = useInvalidationNonce(AGENT_CLIENT_TAGS)
  const viewer = useViewer()
  // The write routes also require an editor-ranked role.
  const canWrite = permitted && viewer.isEditor
  const emails = useMemberEmails(canReadMembers)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [creating, setCreating] = useState(false)
  const [issued, setIssued] = useState<{ name: string; token: string; rotated: boolean } | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [retry, setRetry] = useState(0)
  const newButtonRef = useRef<HTMLButtonElement | null>(null)
  // The control that opened the token dialog is often gone when it closes.
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoad((current) => (current.kind === 'ready' ? current : { kind: 'loading' }))
    contractApi('GET /agent-clients', '/v1/agent-clients', undefined, { guard: isGetAgentClientsResponse })
      .then((data) => { if (!cancelled) setLoad({ kind: 'ready', data }) })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoad(isForbiddenApiError(error)
          ? { kind: 'forbidden' }
          : { kind: 'error', message: tApiError(error) || t('agentClients.error.load') })
      })
    return () => { cancelled = true }
  }, [nonce, retry, t])

  const refresh = useCallback(() => bumpPlatformVersion(AGENT_CLIENT_MUTATION_TAGS), [bumpPlatformVersion])

  const loadMore = async () => {
    const cursor = load.kind === 'ready' ? load.data.nextCursor : null
    if (!cursor) return
    setLoadingMore(true)
    try {
      const next = await contractApi('GET /agent-clients', `/v1/agent-clients?cursor=${encodeURIComponent(cursor)}`,
        undefined, { guard: isGetAgentClientsResponse })
      // A refresh that landed meanwhile owns the list; this page no longer follows it.
      setLoad((current) => current.kind === 'ready' && current.data.nextCursor === cursor
        ? { kind: 'ready', data: { ...next, clients: [...current.data.clients, ...next.clients] } }
        : current)
    } catch (error) {
      addToast(tApiError(error) || t('agentClients.error.load'), 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  const created = (result: IssuedAgentClient) => {
    returnFocusRef.current = newButtonRef.current
    setCreating(false)
    setIssued({ name: result.client.name, token: result.token, rotated: false })
    refresh()
  }

  const rotate = async (client: AgentClient) => {
    if (!(await confirm({
      title: t('agentClients.rotate.title', { name: client.name }),
      body: t('agentClients.rotate.body', { last4: client.tokenLast4 }),
      confirmLabel: t('agentClients.action.rotate'),
      tone: 'danger',
    }))) return
    returnFocusRef.current = document.getElementById(`agent-client-rotate-${client.id}`)
    setBusyId(client.id)
    try {
      // The new token must have a dialog to land in before the old one dies.
      await loadDialogs()
      // A private signal keeps the token-bearing response out of request dedup.
      const result = await contractApi('POST /agent-clients/{id}/rotate', `/v1/agent-clients/${encodeURIComponent(client.id)}/rotate`, {},
        { guard: isPostAgentClientsIdRotateResponse, signal: new AbortController().signal })
      setIssued({ name: result.client.name, token: result.token, rotated: true })
      refresh()
    } catch (error) {
      addToast(tApiError(error) || t('agentClients.error.rotate'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const revoke = async (client: AgentClient) => {
    const capabilities = client.capabilities.map((capability) => t(`agentClients.capability.${capability}.label`)).join(', ')
    if (!(await confirm({
      title: t('agentClients.revoke.title', { name: client.name }),
      body: client.origin === 'oauth'
        ? t('agentClients.revoke.bodyOauth', { capabilities })
        : t('agentClients.revoke.body', { last4: client.tokenLast4, capabilities }),
      confirmLabel: t('agentClients.action.revoke'),
      tone: 'danger',
    }))) return
    setBusyId(client.id)
    try {
      await contractApi('POST /agent-clients/{id}/revoke', `/v1/agent-clients/${encodeURIComponent(client.id)}/revoke`, undefined,
        { guard: isPostAgentClientsIdRevokeResponse })
      addToast(t('agentClients.revoke.done', { name: client.name }), 'success')
      refresh()
    } catch (error) {
      addToast(tApiError(error) || t('agentClients.error.revoke'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const closeToken = () => {
    setIssued(null)
    const target = returnFocusRef.current
    returnFocusRef.current = null
    requestAnimationFrame(() => (target?.isConnected ? target : newButtonRef.current)?.focus())
  }

  const names = { userId: viewer.userId, emails }
  const clients = load.kind === 'ready' ? load.data.clients : []

  return (
    <section className="we-agent-clients" aria-labelledby="agent-clients-title" data-testid="agent-clients-panel">
      <header className="we-agent-clients__header">
        <h3 id="agent-clients-title">{t('agentClients.title')}</h3>
        <div className="we-agent-clients__header-actions">
          <Button size="sm" variant="ghost" onClick={() => setRetry((count) => count + 1)} aria-label={t('common.refresh')}>
            <RefreshCw size={13} aria-hidden="true" />
          </Button>
          {canWrite && load.kind === 'ready' && (
            <Button ref={newButtonRef} size="sm" variant="primary" onClick={() => setCreating(true)} data-testid="agent-client-new">
              {t('agentClients.action.new')}
            </Button>
          )}
        </div>
      </header>

      {load.kind === 'loading' && <LoadingSkeleton rows={3} label={t('common.loading')} />}
      {load.kind === 'forbidden' && (
        <EmptyState icon={<LockKeyhole size={18} />} kicker={t('agentClients.forbidden.kicker')} body={t('agentClients.forbidden.body')} testId="agent-clients-forbidden" />
      )}
      {load.kind === 'error' && (
        <div className="we-agent-clients__error" role="alert">
          <span>{load.message}</span>
          <Button size="sm" variant="secondary" onClick={() => setRetry((count) => count + 1)}>
            <RefreshCw size={13} aria-hidden="true" /> {t('common.retry')}
          </Button>
        </div>
      )}
      {load.kind === 'ready' && clients.length === 0 && (
        <EmptyState
          icon={<Bot size={18} />}
          kicker={t('agentClients.empty.kicker')}
          body={t('agentClients.empty.body')}
          cta={canWrite ? { label: t('agentClients.action.new'), onClick: () => setCreating(true) } : undefined}
          testId="agent-clients-empty"
        />
      )}
      {load.kind === 'ready' && clients.length > 0 && (
        <div className="we-agent-clients__table-wrap">
          <table className="we-table we-table--compact we-agent-clients__table">
            <caption className="we-sr-only">{t('agentClients.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('workflowsDashboard.columnName')}</th>
                <th scope="col">{t('agentClients.column.capabilities')}</th>
                <th scope="col">{t('alerts.form.scope')}</th>
                <th scope="col">{t('workflowsDashboard.columnExpires')}</th>
                <th scope="col">{t('agentClients.column.createdBy')}</th>
                <th scope="col">{t('rightPanel.runs.status')}</th>
                <th scope="col"><span className="we-sr-only">{t('workflowsDashboard.columnActions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => {
                const state = agentClientState(client)
                const own = viewer.userId !== null && client.createdBy === viewer.userId
                // An OAuth grant refreshes its own token; the API refuses a rotation.
                const canRotate = canWrite && own && client.status === 'active' && client.origin !== 'oauth'
                const canRevoke = canWrite && (own || viewer.isAdmin) && client.status !== 'revoked'
                const open = openId === client.id
                const scope = client.scope.workflowIds.length + client.scope.tags.length === 0
                  ? t('agentClients.scope.organization')
                  : [
                      client.scope.workflowIds.length > 0 ? t('agentClients.scope.workflows', { count: client.scope.workflowIds.length }) : null,
                      ...client.scope.tags.map((tag) => `#${tag}`),
                    ].filter(Boolean).join(' · ')
                return [
                  <tr key={client.id} data-testid={`agent-client-${client.id}`} data-state={state}
                    data-dimmed={state === 'revoked' || state === 'expired' ? 'true' : undefined}>
                    <th scope="row">
                      <button
                        type="button"
                        className="we-agent-clients__toggle"
                        aria-expanded={open}
                        aria-controls={open ? `agent-client-detail-${client.id}` : undefined}
                        onClick={() => setOpenId(open ? null : client.id)}
                        data-testid={`agent-client-open-${client.id}`}
                      >
                        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                        <span className="we-agent-clients__name">{client.name}</span>
                      </button>
                      <span className="we-agent-clients__meta">
                        {client.origin === 'oauth' ? t('agentClients.origin.oauth') : `…${client.tokenLast4}`}
                      </span>
                    </th>
                    <td>
                      <ul className="we-agent-clients__caps" aria-label={t('agentClients.column.capabilities')}>
                        {client.capabilities.map((capability) => (
                          <li key={capability} className="we-pill" data-tone="neutral">{t(`agentClients.capability.${capability}.label`)}</li>
                        ))}
                      </ul>
                    </td>
                    <td>{scope}</td>
                    <td>{formatWhen(client.expiresAt)}</td>
                    <td>{actorLabel(client.createdBy, names, t)}</td>
                    <td>
                      <span className="we-pill we-agent-clients__state" data-tone={STATE_TONE[state]} data-testid={`agent-client-state-${client.id}`}>
                        {STATE_ICON[state]} {t(`agentClients.state.${state}`)}
                      </span>
                    </td>
                    <td className="we-agent-clients__actions">
                      {canRotate && (
                        <Button id={`agent-client-rotate-${client.id}`} size="sm" variant="ghost" disabled={busyId !== null} onClick={() => void rotate(client)}
                          aria-label={t('agentClients.action.rotateNamed', { name: client.name })}>
                          {t('agentClients.action.rotate')}
                        </Button>
                      )}
                      {canRevoke && (
                        <Button size="sm" variant="danger" disabled={busyId !== null} onClick={() => void revoke(client)}
                          aria-label={t('agentClients.action.revokeNamed', { name: client.name })}>
                          {t('agentClients.action.revoke')}
                        </Button>
                      )}
                    </td>
                  </tr>,
                  open && (
                    <tr key={`${client.id}-detail`} className="we-agent-clients__detail-row">
                      <td colSpan={7} id={`agent-client-detail-${client.id}`}>
                        <Suspense fallback={<LoadingSkeleton rows={2} label={t('common.loading')} />}>
                          <AgentClientDetail clientId={client.id} nonce={nonce} />
                        </Suspense>
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
          {load.data.nextCursor && (
            <Button size="sm" variant="secondary" loading={loadingMore} loadingLabel={t('common.loading')} onClick={() => void loadMore()}>
              {t('agentClients.action.more')}
            </Button>
          )}
        </div>
      )}

      {creating && load.kind === 'ready' && (
        <Suspense fallback={null}>
          <CreateAgentClientDialog catalog={load.data} onClose={() => setCreating(false)} onCreated={created} />
        </Suspense>
      )}
      {issued && (
        <Suspense fallback={null}>
          <AgentTokenDialog clientName={issued.name} token={issued.token} rotated={issued.rotated} onClose={closeToken} />
        </Suspense>
      )}
    </section>
  )
}
