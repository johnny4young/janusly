/**
 * Agent publish requests: who waits on whom, filtered by state. Whether the
 * viewer may decide comes from the server. The pending list refreshes on its
 * own while visible, so a request an agent opens shows up without a reload.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardCheck, LockKeyhole, RefreshCw } from 'lucide-react'

import { contractApi, isForbiddenApiError } from '../api'
import { tApiError, useT } from '../i18n'
import type { ApiResponse } from '../lib/api-types.generated'
import { isGetPublishRequestsResponse } from '../lib/api-guards/operations/GetPublishRequests'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { onRouteChange, readRoute, writeRoute } from '../lib/route'
import type { ActiveTab } from '../types'
import { actorLabel, formatWhen, useMemberEmails, useViewer } from './agent-actors'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Button } from './ui/Button'
import './PublishRequestsPanel.css'

const PublishRequestDetail = lazy(() => import('./PublishRequestDetail').then((module) => ({ default: module.PublishRequestDetail })))

type PublishRequest = ApiResponse<'GET /publish-requests'>['requests'][number]
export type PublishRequestStatus = PublishRequest['status']
type Filter = 'yours' | PublishRequestStatus
type Load = { kind: 'loading' } | { kind: 'forbidden' } | { kind: 'error'; message: string } | { kind: 'ready'; requests: PublishRequest[] }

const FILTERS: readonly Filter[] = ['yours', 'pending', 'published', 'rejected', 'expired', 'superseded']
const LIST_TAGS = [PLATFORM_TAG, 'workflows'] as const
const POLL_MS = 10_000

export const STATUS_TONE: Record<PublishRequestStatus, string> = {
  pending: 'warning', published: 'success', rejected: 'danger', expired: 'neutral', superseded: 'neutral',
}

function routedRequestId(): string | null {
  const route = readRoute()
  return route?.tab === 'publishRequests' ? route.publishRequestId ?? null : null
}

export function PublishRequestsPanel({
  canReadMembers,
  onOpenWorkflow,
  onOpenWorkflowVersion,
  onOpenRun,
}: {
  canReadMembers: boolean
  onOpenWorkflow: (id: string) => void
  onOpenWorkflowVersion: (workflowId: string, versionId: string, targetTab?: ActiveTab) => Promise<boolean>
  onOpenRun: (id: string, targetTab?: ActiveTab) => void | Promise<void>
}) {
  const { t } = useT()
  const nonce = useInvalidationNonce(LIST_TAGS)
  const viewer = useViewer()
  const emails = useMemberEmails(canReadMembers)
  const [filter, setFilter] = useState<Filter>('pending')
  const [list, setList] = useState<Load>({ kind: 'loading' })
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const listRef = useRef(list)
  listRef.current = list
  const [pending, setPending] = useState<PublishRequest[] | null>(null)
  const [tick, setTick] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(routedRequestId)
  const selectedRef = useRef(selectedId)
  const refresh = useCallback(() => setTick((count) => count + 1), [])

  useEffect(() => onRouteChange((route) => {
    if (route?.tab !== 'publishRequests') return
    const id = route.publishRequestId ?? null
    if (id === selectedRef.current) return
    selectedRef.current = id
    setSelectedId(id)
  }), [])

  // Pending requests drive both the default list and the count of those
  // waiting on this person, so they refresh while the panel is visible.
  useEffect(() => {
    const poll = () => { if (document.visibilityState === 'visible') refresh() }
    const timer = window.setInterval(poll, POLL_MS)
    window.addEventListener('focus', poll)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', poll)
    }
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    const status = filter === 'yours' ? 'pending' : filter
    // A refresh keeps the rows on screen; only switching filters shows loading.
    setList((current) => (current.kind === 'ready' ? current : { kind: 'loading' }))
    contractApi('GET /publish-requests', `/v1/publish-requests?status=${status}`, undefined, { guard: isGetPublishRequestsResponse })
      .then((data) => {
        if (cancelled) return
        if (status === 'pending') setPending(data.requests)
        setRefreshError(null)
        setList({ kind: 'ready', requests: filter === 'yours' ? data.requests.filter((request) => request.viewer.canDecide) : data.requests })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = tApiError(error) || t('publishRequests.error.load')
        const forbidden = isForbiddenApiError(error)
        // A failed refresh keeps the rows and an open decision on screen.
        if (listRef.current.kind === 'ready' && !forbidden) setRefreshError(message)
        else setList(forbidden ? { kind: 'forbidden' } : { kind: 'error', message })
      })
    return () => { cancelled = true }
  }, [filter, nonce, tick, t])

  // The count stays current on other filters too.
  useEffect(() => {
    if (filter === 'pending' || filter === 'yours') return
    let cancelled = false
    contractApi('GET /publish-requests', '/v1/publish-requests?status=pending', undefined, { guard: isGetPublishRequestsResponse })
      .then((data) => { if (!cancelled) setPending(data.requests) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [filter, nonce, tick])

  const choose = (next: Filter) => {
    if (next === filter) return
    setRefreshError(null)
    setList({ kind: 'loading' })
    setFilter(next)
  }

  const select = (id: string) => {
    selectedRef.current = id
    setSelectedId(id)
    writeRoute({ tab: 'publishRequests', publishRequestId: id }, 'replace')
  }

  const names = { userId: viewer.userId, emails }
  const waiting = pending?.filter((request) => request.viewer.canDecide).length ?? null
  const requests = list.kind === 'ready' ? list.requests : []

  return (
    <div className="we-publish-requests" data-testid="publish-requests-panel">
      <div className="we-publish-requests__views" role="group" aria-label={t('publishRequests.views')}>
        {FILTERS.map((item) => (
          <Button key={item} size="sm" variant="ghost" aria-pressed={filter === item} onClick={() => choose(item)}
            data-testid={`publish-requests-filter-${item}`}>
            {t(`publishRequests.filter.${item}`)}
            {item === 'yours' && waiting !== null && waiting > 0 && (
              <span className="we-pill" data-tone="warning" aria-label={t('publishRequests.waitingForYou', { count: waiting })}
                data-testid="publish-requests-waiting">{waiting}</span>
            )}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="we-publish-requests__refresh" onClick={refresh} aria-label={t('common.refresh')}
          data-testid="publish-requests-refresh">
          <RefreshCw size={13} aria-hidden="true" />
        </Button>
      </div>

      {refreshError && list.kind === 'ready' && (
        <p className="we-publish-requests__error" role="status" data-testid="publish-requests-refresh-error">{refreshError}</p>
      )}
      {list.kind === 'loading' && <LoadingSkeleton rows={3} label={t('common.loading')} />}
      {list.kind === 'forbidden' && (
        <EmptyState icon={<LockKeyhole size={18} />} kicker={t('publishRequests.forbidden.kicker')} body={t('publishRequests.forbidden.body')} testId="publish-requests-forbidden" />
      )}
      {list.kind === 'error' && (
        <div className="we-publish-requests__error" role="alert">
          <span>{list.message}</span>
          <Button size="sm" variant="secondary" onClick={refresh}>
            <RefreshCw size={13} aria-hidden="true" /> {t('common.retry')}
          </Button>
        </div>
      )}
      {list.kind === 'ready' && (requests.length > 0 || selectedId) && (
        <div className="we-publish-requests__layout">
          {requests.length === 0
            ? <p className="we-publish-requests__hint" data-testid="publish-requests-none">{t(`publishRequests.empty.${filter}`)}</p>
            : (
              <ul className="we-publish-requests__list" aria-label={t(`publishRequests.filter.${filter}`)}>
                {requests.map((request) => (
                  <li key={request.id}>
                    <button
                      type="button"
                      className="we-publish-requests__row"
                      aria-current={request.id === selectedId ? 'true' : undefined}
                      onClick={() => select(request.id)}
                      data-testid={`publish-request-${request.id}`}
                    >
                      <span className="we-publish-requests__row-title">
                        <strong>{request.workflowName ?? request.workflowId}</strong>
                        <span className="we-pill" data-tone={STATUS_TONE[request.status]}>{t(`publishRequests.status.${request.status}`)}</span>
                        {request.viewer.canDecide && <span className="we-pill" data-tone="info">{t('publishRequests.needsYou')}</span>}
                      </span>
                      <span className="we-publish-requests__row-meta">
                        {request.requesterName ?? actorLabel(request.requestedBy, names, t)}
                        {' · '}{t('publishRequests.forPerson', { person: actorLabel(request.onBehalfOf, names, t) })}
                      </span>
                      <span className="we-publish-requests__row-meta">
                        {request.reasons.map((reason) => t(`publishRequests.reason.${reason}`)).join(' · ')}
                      </span>
                      {request.status === 'pending' && (
                        <span className="we-publish-requests__row-meta">{t('publishRequests.expires', { when: formatWhen(request.expiresAt) })}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          <div className="we-publish-requests__detail">
            {selectedId
              ? (
                <Suspense fallback={<LoadingSkeleton rows={4} label={t('common.loading')} />}>
                  <PublishRequestDetail
                    key={selectedId}
                    id={selectedId}
                    names={names}
                    onDecided={refresh}
                    onOpenWorkflow={onOpenWorkflow}
                    onOpenWorkflowVersion={onOpenWorkflowVersion}
                    onOpenRun={onOpenRun}
                  />
                </Suspense>
              )
              : <p className="we-publish-requests__hint">{t('publishRequests.select')}</p>}
          </div>
        </div>
      )}
      {list.kind === 'ready' && requests.length === 0 && !selectedId && (
        <EmptyState
          icon={<ClipboardCheck size={18} />}
          kicker={t(`publishRequests.empty.${filter}`)}
          body={t('publishRequests.empty.body')}
          testId="publish-requests-empty"
        />
      )}
    </div>
  )
}
