/**
 * One publish request in the order a person decides it: what it does
 * outside Janusly, why it waits, what it changes in production, the
 * qualification evidence, then the decision the server allows this viewer.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, CircleX, ExternalLink, LockKeyhole } from 'lucide-react'

import { contractApi } from '../api'
import { tApiError, useT } from '../i18n'
import type { ApiResponse } from '../lib/api-types.generated'
import { isGetPublishRequestsIdResponse } from '../lib/api-guards/operations/GetPublishRequestsId'
import { isPostPublishRequestsIdApproveResponse } from '../lib/api-guards/operations/PostPublishRequestsIdApprove'
import { isPostPublishRequestsIdRejectResponse } from '../lib/api-guards/operations/PostPublishRequestsIdReject'
import { useWorkflowStore } from '../store'
import type { ActiveTab, WorkflowDefinition } from '../types'
import { actorLabel, formatWhen } from './agent-actors'
import { LoadingSkeleton } from './LoadingSkeleton'
import { STATUS_TONE } from './PublishRequestsPanel'
import { WorkflowDiffView } from './WorkflowDiffView'
import { Button } from './ui/Button'
import { FormField } from './ui/Form'

type Detail = ApiResponse<'GET /publish-requests/{id}'>
type Refusal = NonNullable<Detail['request']['viewer']['refusal']>
type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; detail: Detail }
type Diff = { before: WorkflowDefinition; after: WorkflowDefinition } | 'unavailable' | null

const DECISION_TAGS = ['workflows', 'versions'] as const
const EMPTY_WORKFLOW: WorkflowDefinition = { nodes: [], edges: [] }
const QUALIFICATION_STATUS: Record<Detail['qualification']['status'], string> = {
  running: 'status.running', passed: 'workflowRollout.qualification.status.passed', failed: 'workflowRollout.qualification.status.failed',
}
// Refusals that still leave a rejection open: the server says to reject them.
const REJECT_ONLY: ReadonlySet<Refusal> = new Set(['stale_base', 'creator_unknown'])

export function PublishRequestDetail({
  id,
  names,
  onDecided,
  onOpenWorkflow,
  onOpenWorkflowVersion,
  onOpenRun,
}: {
  id: string
  names: Parameters<typeof actorLabel>[1]
  onDecided: () => void
  onOpenWorkflow: (id: string) => void
  onOpenWorkflowVersion: (workflowId: string, versionId: string, targetTab?: ActiveTab) => Promise<boolean>
  onOpenRun: (id: string, targetTab?: ActiveTab) => void | Promise<void>
}) {
  const { t } = useT()
  const formId = useId()
  const addToast = useWorkflowStore((state) => state.addToast)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const reasonRef = useRef<HTMLTextAreaElement | null>(null)
  const outcomeRef = useRef<HTMLParagraphElement | null>(null)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [diff, setDiff] = useState<Diff>(null)
  const [reason, setReason] = useState('')
  const [reasonMissing, setReasonMissing] = useState(false)
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Its own signal: a reload right after a refused decision must not reuse
    // the request dedup's copy of the previous read.
    const controller = new AbortController()
    contractApi('GET /publish-requests/{id}', `/v1/publish-requests/${encodeURIComponent(id)}`, undefined,
      { guard: isGetPublishRequestsIdResponse, signal: controller.signal })
      .then(async (detail) => {
        if (cancelled) return
        setLoad({ kind: 'ready', detail })
        const { isWorkflowDefinition } = await import('../lib/authoring-contract')
        const before = detail.current ? detail.current.document : EMPTY_WORKFLOW
        if (!cancelled) {
          setDiff(isWorkflowDefinition(before) && isWorkflowDefinition(detail.proposed) ? { before, after: detail.proposed } : 'unavailable')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ kind: 'error', message: tApiError(error) || t('publishRequests.error.detail') })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [id, reload, t])

  if (load.kind === 'loading') return <LoadingSkeleton rows={4} label={t('common.loading')} />
  if (load.kind === 'error') return <p className="we-publish-requests__error" role="alert">{load.message}</p>

  const { request, qualification, current, effects, changes } = load.detail
  const title = request.workflowName ?? request.workflowId
  const viewerRefusal = request.viewer.refusal
  const canReject = request.viewer.canDecide || (viewerRefusal !== null && REJECT_ONLY.has(viewerRefusal))
  const removed = changes ? [...changes.triggersChanged, ...changes.stepsRemoved, ...changes.outputsRemoved].length : 0

  const decide = async (decision: 'approve' | 'reject') => {
    const trimmed = reason.trim()
    if (decision === 'reject' && trimmed === '') {
      setReasonMissing(true)
      reasonRef.current?.focus()
      return
    }
    setDeciding(decision)
    setRefusal(null)
    try {
      const requestId = encodeURIComponent(request.id)
      const body = trimmed === '' ? {} : { reason: trimmed }
      const result = decision === 'approve'
        ? await contractApi('POST /publish-requests/{id}/approve', `/v1/publish-requests/${requestId}/approve`, body,
          { guard: isPostPublishRequestsIdApproveResponse })
        : await contractApi('POST /publish-requests/{id}/reject', `/v1/publish-requests/${requestId}/reject`, body,
          { guard: isPostPublishRequestsIdRejectResponse })
      setLoad({ kind: 'ready', detail: { ...load.detail, request: result.request } })
      addToast(t(decision === 'approve' ? 'publishRequests.decision.approved' : 'publishRequests.decision.rejected', { name: title }), 'success')
      bumpPlatformVersion(DECISION_TAGS)
      onDecided()
    } catch (error) {
      setRefusal(tApiError(error) || t('publishRequests.error.decide'))
      setReload((count) => count + 1)
      requestAnimationFrame(() => outcomeRef.current?.focus())
    } finally {
      setDeciding(null)
    }
  }

  return (
    <article className="we-publish-request" aria-labelledby={`${formId}-title`} data-testid="publish-request-detail">
      <header className="we-publish-request__header">
        <h3 id={`${formId}-title`}>{title}</h3>
        <span className="we-pill" data-tone={STATUS_TONE[request.status]} data-testid="publish-request-status">
          {t(`publishRequests.status.${request.status}`)}
        </span>
        {(current || request.status === 'published') && (
          <Button size="sm" variant="secondary" onClick={() => onOpenWorkflow(request.workflowId)} data-testid="publish-request-open-workflow">
            <ExternalLink size={13} aria-hidden="true" /> {t('palette.dynamic.openWorkflow')}
          </Button>
        )}
      </header>

      <dl className="we-publish-request__facts">
        {request.proposedName && (
          <>
            <dt>{t('publishRequests.field.proposedName')}</dt>
            <dd data-testid="publish-request-renamed">{request.proposedName}</dd>
          </>
        )}
        <dt>{t('publishRequests.field.requestedBy')}</dt>
        <dd>{request.requesterName ?? actorLabel(request.requestedBy, names, t)}</dd>
        <dt>{t('publishRequests.field.onBehalfOf')}</dt>
        <dd>{actorLabel(request.onBehalfOf, names, t)}</dd>
        {request.status === 'pending' && (
          <>
            <dt>{t('workflowsDashboard.columnExpires')}</dt>
            <dd>{formatWhen(request.expiresAt)}</dd>
          </>
        )}
      </dl>

      <section className="we-publish-request__section" aria-labelledby={`${formId}-effects`}>
        <h4 id={`${formId}-effects`}>{t('publishRequests.effects.title')}</h4>
        {effects === null && <p className="we-publish-request__muted">{t('publishRequests.effects.unavailable')}</p>}
        {effects !== null && effects.length === 0 && <p className="we-publish-request__muted">{t('publishRequests.effects.none')}</p>}
        {effects !== null && effects.length > 0 && (
          <ul className="we-publish-request__effects" data-testid="publish-request-effects">
            {effects.map((effect) => (
              <li key={`${effect.kind}-${effect.nodeId}`}>
                {effect.kind === 'outputs'
                  ? <span>{t('publishRequests.effects.outputs')}</span>
                  : (
                    <>
                      <code>{effect.nodeId}</code>
                      <span className="we-pill" data-tone={effect.writes ? 'warning' : 'neutral'}>
                        {t(effect.writes ? 'publishRequests.effects.writes' : 'publishRequests.effects.reaches')}
                      </span>
                      <span>{effect.tool || effect.type}</span>
                    </>
                  )}
                {effect.target && <span className="we-publish-request__muted">{t('publishRequests.effects.target', { target: effect.target })}</span>}
                {effect.credentials.length > 0 && (
                  <span className="we-publish-request__muted">
                    {t('publishRequests.effects.credentials', { names: effect.credentials.join(', ') })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="we-publish-request__section" aria-labelledby={`${formId}-reasons`}>
        <h4 id={`${formId}-reasons`}>{t('publishRequests.field.reasons')}</h4>
        <ul className="we-publish-request__reasons" data-testid="publish-request-reasons">
          {request.reasons.map((item) => (
            <li key={item} className="we-pill" data-tone="neutral">{t(`publishRequests.reason.${item}`)}</li>
          ))}
        </ul>
      </section>

      <section className="we-publish-request__section" aria-labelledby={`${formId}-changes`}>
        <h4 id={`${formId}-changes`}>{t('publishRequests.changes.title')}</h4>
        {changes && removed > 0 && (
          <ul className="we-publish-request__removed" data-testid="publish-request-removed">
            {changes.triggersChanged.length > 0 && <li>{t('publishRequests.changes.triggersChanged', { ids: changes.triggersChanged.join(', ') })}</li>}
            {changes.stepsRemoved.length > 0 && <li>{t('publishRequests.changes.stepsRemoved', { ids: changes.stepsRemoved.join(', ') })}</li>}
            {changes.outputsRemoved.length > 0 && <li>{t('publishRequests.changes.outputsRemoved', { ids: changes.outputsRemoved.join(', ') })}</li>}
          </ul>
        )}
        {diff === null && <p className="we-publish-request__muted" role="status">{t('common.loading')}</p>}
        {diff === 'unavailable' && <p className="we-publish-request__muted">{t('publishRequests.changes.unavailable')}</p>}
        {diff !== null && diff !== 'unavailable' && (
          <WorkflowDiffView
            before={diff.before}
            after={diff.after}
            beforeLabel={current ? t('publishRequests.changes.current', { version: current.version }) : t('publishRequests.changes.none')}
            afterLabel={t('publishRequests.changes.proposed')}
          />
        )}
      </section>

      <section className="we-publish-request__section" aria-labelledby={`${formId}-qualification`}>
        <h4 id={`${formId}-qualification`}>
          {t('publishRequests.qualification.title')}
          <span className="we-pill" data-tone={qualification.status === 'passed' ? 'success' : qualification.status === 'failed' ? 'danger' : 'neutral'}>
            {t(QUALIFICATION_STATUS[qualification.status])}
          </span>
        </h4>
        <ul className="we-publish-request__checks">
          {qualification.checks.map((check, index) => (
            <li key={`${check.code}-${index}`} data-status={check.status}>
              {check.status === 'passed'
                ? <CheckCircle2 size={14} role="img" aria-label={t('workflowRollout.qualification.status.passed')} />
                : <CircleX size={14} role="img" aria-label={t('workflowRollout.qualification.status.failed')} />}
              <span>
                <code>{check.code}</code> {check.message}
                {check.path && <span className="we-publish-request__muted"> · {check.path}</span>}
                {check.fix && <span className="we-publish-request__fix">{check.fix}</span>}
              </span>
            </li>
          ))}
          {qualification.fixtureRuns.map((run, index) => (
            <li key={`${run.fixture}-${index}`} data-status={run.status}>
              {run.status === 'passed'
                ? <CheckCircle2 size={14} role="img" aria-label={t('workflowRollout.qualification.status.passed')} />
                : run.status === 'failed'
                  ? <CircleX size={14} role="img" aria-label={t('workflowRollout.qualification.status.failed')} />
                  : <CircleAlert size={14} role="img" aria-label={t('status.running')} />}
              <span>
                {t('publishRequests.qualification.fixture', { name: run.fixture })}
                {run.detail && <span className="we-publish-request__muted"> · {run.detail}</span>}
              </span>
              {run.runId && (
                <Button size="sm" variant="ghost" onClick={() => void onOpenRun(run.runId as string)}
                  aria-label={t('publishRequests.qualification.openRun', { name: run.fixture })}>
                  <ExternalLink size={12} aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {refusal && <p ref={outcomeRef} tabIndex={-1} className="we-publish-request__refusal" role="alert" data-testid="publish-request-error">{refusal}</p>}

      <section className="we-publish-request__section" aria-labelledby={`${formId}-decision`}>
        <h4 id={`${formId}-decision`}>{t('publishRequests.decision.title')}</h4>
        {request.status === 'published' && request.publishedVersionId && (
          <Button size="sm" variant="secondary" data-testid="publish-request-open-version"
            onClick={() => void onOpenWorkflowVersion(request.workflowId, request.publishedVersionId as string)}>
            <ExternalLink size={13} aria-hidden="true" /> {t('publishRequests.decision.openVersion')}
          </Button>
        )}
        {request.decidedBy && (
          <p className="we-publish-request__muted" data-testid="publish-request-decided">
            {t('publishRequests.decision.decidedBy', { person: actorLabel(request.decidedBy, names, t), when: formatWhen(request.decidedAt) })}
            {request.decisionReason && <span className="we-publish-request__reason"> “{request.decisionReason}”</span>}
          </p>
        )}
        {request.status !== 'pending' && !request.decidedBy && (
          <p className="we-publish-request__muted">{t(`publishRequests.closed.${request.status}`)}</p>
        )}
        {request.status === 'pending' && viewerRefusal && viewerRefusal !== 'settled' && (
          <p className="we-publish-request__muted" data-testid="publish-request-refusal">
            <LockKeyhole size={13} aria-hidden="true" /> {t(`publishRequests.refusal.${viewerRefusal}`)}
          </p>
        )}
        {request.status === 'pending' && canReject && (
          <form className="we-publish-request__decision" onSubmit={(event) => event.preventDefault()}>
            <FormField
              id={`${formId}-reason`}
              label={t('publishRequests.decision.reason')}
              error={reasonMissing ? t('publishRequests.decision.reasonRequired') : undefined}
            >
              {(controlProps) => (
                <textarea
                  {...controlProps}
                  ref={reasonRef}
                  rows={3}
                  maxLength={500}
                  value={reason}
                  disabled={deciding !== null}
                  onChange={(event) => {
                    setReason(event.target.value)
                    if (event.target.value.trim()) setReasonMissing(false)
                  }}
                />
              )}
            </FormField>
            <div className="we-publish-request__actions">
              {request.viewer.canDecide && (
                <Button variant="primary" loading={deciding === 'approve'} loadingLabel={t('common.working')}
                  disabled={deciding !== null} onClick={() => void decide('approve')} data-testid="publish-request-approve">
                  {t('publishRequests.decision.approve')}
                </Button>
              )}
              <Button variant="danger" loading={deciding === 'reject'} loadingLabel={t('common.working')}
                disabled={deciding !== null} onClick={() => void decide('reject')} data-testid="publish-request-reject">
                {t('publishRequests.decision.reject')}
              </Button>
            </div>
          </form>
        )}
      </section>
    </article>
  )
}
