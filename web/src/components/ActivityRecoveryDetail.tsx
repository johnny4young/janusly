import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Copy,
  Download,
  ExternalLink,
  FlaskConical,
  RefreshCcw,
  Sparkles,
} from 'lucide-react'

import { downloadFromApi, contractApi } from '../api'
import { copyText } from '../clipboard'
import { formatStatusLabel, getNodeLabel } from '../constants'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { buildRecoveryErrorSummary } from '../recovery-error-summary'
import { useWorkflowStore } from '../store'
import type { DeadLetter } from './dead-letter-types'
import { RecoveryDrillOutcomeCard } from './recovery/RecoveryDrillOutcomeCard'
import { ReplayLabDialog } from './ReplayLabDialog'
import { RunExplainChat } from './RunExplainChat'

const RecoveryDialog = lazy(() => import('./RecoveryDialog').then(module => ({
  default: module.RecoveryDialog,
})))

type DetailState =
  | { id: string; kind: 'loading'; summaryStatus: string; value: null }
  | { id: string; kind: 'ready'; summaryStatus: string; value: DeadLetter }
  | { id: string; kind: 'error'; summaryStatus: string; value: null }

export type ActivityRecoveryDetailProps = {
  deadLetter: DeadLetter
  initialDetail?: DeadLetter
  onOpenRun: (runId: string) => void
  onReplay: (id: string, createdAtIso?: string) => boolean | Promise<boolean> | undefined
  onResolve: (id: string) => boolean | Promise<boolean> | undefined
  canReplay?: boolean
  canResolve?: boolean
  canStartRuns?: boolean
  canUseRecovery?: boolean
}

export function mergeActivityRecoveryDetail(
  summary: DeadLetter,
  detail: DeadLetter,
  summaryStatusAtFetch = summary.status,
): DeadLetter {
  const workflowSnapshot = detail.workflowJson && typeof detail.workflowJson === 'object'
    ? detail.workflowJson as Record<string, unknown>
    : null
  const nodeSnapshot = detail.nodeJson && typeof detail.nodeJson === 'object'
    ? detail.nodeJson as Record<string, unknown>
    : null
  const snapshotWorkflowName = typeof workflowSnapshot?.name === 'string'
    ? workflowSnapshot.name
    : undefined
  const snapshotNodeType = typeof nodeSnapshot?.type === 'string'
    ? nodeSnapshot.type
    : undefined
  return {
    ...summary,
    ...detail,
    status: summary.status === summaryStatusAtFetch ? detail.status : summary.status,
    workflowName: detail.workflowName ?? summary.workflowName ?? snapshotWorkflowName,
    nodeType: detail.nodeType ?? summary.nodeType ?? snapshotNodeType,
    createdAt: detail.createdAt ?? summary.createdAt,
  }
}

function DetailBlock({
  title,
  value,
  initiallyOpen = false,
}: {
  title: string
  value: unknown
  initiallyOpen?: boolean
}) {
  const { t } = useT()
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <div className="detail-block">
      <button type="button" className="small-command" onClick={() => setOpen(value => !value)}>
        {t(open ? 'dlq.detail.hide' : 'dlq.detail.show', { title })}
      </button>
      {open && <pre className="mini-pre">{JSON.stringify(value ?? {}, null, 2)}</pre>}
    </div>
  )
}

export function ActivityRecoveryDetail({
  deadLetter,
  initialDetail,
  onOpenRun,
  onReplay,
  onResolve,
  canReplay = true,
  canResolve = true,
  canStartRuns = true,
  canUseRecovery = true,
}: ActivityRecoveryDetailProps) {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const [detail, setDetail] = useState<DetailState>(() =>
    initialDetail?.id === deadLetter.id
      ? {
          id: deadLetter.id,
          kind: 'ready',
          summaryStatus: deadLetter.status,
          value: initialDetail,
        }
      : {
          id: deadLetter.id,
          kind: 'loading',
          summaryStatus: deadLetter.status,
          value: null,
        })
  const [busy, setBusy] = useState<'replay' | 'resolve' | null>(null)
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false)
  const [labSourceRunId, setLabSourceRunId] = useState<string | null>(null)

  useEffect(() => {
    if (initialDetail?.id === deadLetter.id) {
      setDetail({
        id: deadLetter.id,
        kind: 'ready',
        summaryStatus: deadLetter.status,
        value: initialDetail,
      })
      return
    }
    const controller = new AbortController()
    const summaryStatus = deadLetter.status
    setDetail({ id: deadLetter.id, kind: 'loading', summaryStatus, value: null })
    contractApi('GET /dlq', `/dlq?id=${encodeURIComponent(deadLetter.id)}`, undefined, { signal: controller.signal })
      .then(value => {
        if (!controller.signal.aborted) {
          setDetail({
            id: deadLetter.id,
            kind: 'ready',
            summaryStatus,
            value: value as unknown as DeadLetter,
          })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDetail({ id: deadLetter.id, kind: 'error', summaryStatus, value: null })
        }
      })
    return () => controller.abort()
  }, [deadLetter.id, initialDetail])

  const current = detail.id === deadLetter.id && detail.kind === 'ready'
    ? mergeActivityRecoveryDetail(deadLetter, detail.value, detail.summaryStatus)
    : deadLetter
  const isOpen = current.status === 'open'
  const stepLabel = current.nodeType ? getNodeLabel(current.nodeType) : current.nodeId

  const copyError = async () => {
    const copied = await copyText(buildRecoveryErrorSummary(current, {
      workflow: t('dlq.copy.unknownWorkflow'),
      nodeType: t('dlq.copy.unknownNodeType'),
      error: t('dlq.copy.unknownError'),
      timestamp: t('dlq.copy.unknownTimestamp'),
    })).catch(() => false)
    addToast(t(copied ? 'dlq.copy.success' : 'dlq.copy.failed'), copied ? 'success' : 'error')
  }

  const runMutation = async (kind: 'replay' | 'resolve') => {
    setBusy(kind)
    try {
      const succeeded = kind === 'replay'
        ? await onReplay(current.id, current.createdAt)
        : await onResolve(current.id)
      if (succeeded !== false) {
        const status = kind === 'replay' ? 'replayed' : 'resolved'
        setDetail(previous => previous.kind === 'ready' && previous.id === current.id
          ? { ...previous, value: { ...previous.value, status } }
          : previous)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      className="we-activity-recovery"
      data-testid="activity-recovery-detail"
      data-dead-letter-id={current.id}
      aria-label={t('activity.recoveryDetail.aria', { step: stepLabel })}
    >
      <div className="split-row we-activity-detail__heading">
        <div>
          <span className="section-kicker">{t('activity.recoveryDetail.kicker')}</span>
          <h2>{current.workflowName || t('activity.unknownWorkflow')}</h2>
          <p>{t('activity.recoveryDetail.step', { step: stepLabel })}</p>
        </div>
        <span className="status-pill" data-status={busy ? 'running' : current.status}>
          {busy
            ? t(busy === 'replay' ? 'activity.recoveryDetail.replaying' : 'activity.recoveryDetail.resolving')
            : formatStatusLabel(current.status)}
        </span>
      </div>

      <div className="we-activity-detail__actions">
        {canUseRecovery && (
          <button
            type="button"
            className="small-command small-command--primary"
            disabled={!isOpen || detail.kind !== 'ready' || busy !== null}
            onClick={() => setShowRecoveryDialog(true)}
          >
            <Sparkles size={12} aria-hidden="true" />
            {t('dlq.action.suggest')}
          </button>
        )}
        {canReplay && (
          <button
            type="button"
            className="small-command"
            disabled={!isOpen || busy !== null}
            onClick={() => { void runMutation('replay') }}
          >
            <RefreshCcw size={12} aria-hidden="true" />
            {t('dlq.action.retry')}
          </button>
        )}
        {canResolve && (
          <button
            type="button"
            className="small-command"
            disabled={current.status === 'resolved' || busy !== null}
            onClick={() => { void runMutation('resolve') }}
          >
            {t('dlq.action.resolve')}
          </button>
        )}
        <button type="button" className="small-command" onClick={() => onOpenRun(current.runId)}>
          <ExternalLink size={12} aria-hidden="true" />
          {t('activity.recoveryDetail.openRun')}
        </button>
      </div>

      <dl className="we-run-overview__facts we-activity-recovery__facts">
        <div>
          <dt>{t('activity.recoveryDetail.stepLabel')}</dt>
          <dd>{stepLabel}</dd>
        </div>
        <div>
          <dt>{t('activity.recoveryDetail.detected')}</dt>
          <dd>{current.createdAt
            ? new Date(current.createdAt).toLocaleString(getResolvedLocale())
            : '—'}</dd>
        </div>
        <div>
          <dt>{t('rightPanel.runs.runId')}</dt>
          <dd><code title={current.runId}>{current.runId.slice(0, 12)}…</code></dd>
        </div>
      </dl>

      {current.drill && (
        <>
          <div className="we-recovery-drill-context" data-testid="dlq-recovery-drill-context">
            <span className="we-pill" data-tone="info">{t('dlq.drill.label')}</span>
            <span className="we-pill" data-tone="neutral">
              {t(`packs.drill.path.${current.drill.recoveryPath}`, {
                defaultValue: current.drill.recoveryPath,
              })}
            </span>
          </div>
          {current.drillOutcome && (
            <RecoveryDrillOutcomeCard outcome={current.drillOutcome} />
          )}
        </>
      )}

      {detail.kind === 'loading' && (
        <p className="we-activity-detail__state" role="status">
          {t('activity.recoveryDetail.loadingEvidence')}
        </p>
      )}
      {detail.kind === 'error' && (
        <p className="we-activity-detail__state we-activity-detail__state--error" role="alert">
          {t('activity.recoveryDetail.evidenceError')}
        </p>
      )}

      <div className="we-activity-recovery__evidence">
        <div className="split-row">
          <strong>{t('activity.recoveryDetail.evidence')}</strong>
          <div className="we-activity-detail__actions">
            <button type="button" className="small-command" onClick={() => { void copyError() }}>
              <Copy size={12} aria-hidden="true" />
              {t('dlq.action.copyError')}
            </button>
            {canStartRuns && (
              <button
                type="button"
                className="small-command"
                onClick={() => setLabSourceRunId(current.runId)}
              >
                <FlaskConical size={12} aria-hidden="true" />
                {t('dlq.action.replayInLab')}
              </button>
            )}
            <button
              type="button"
              className="small-command"
              onClick={async () => {
                try {
                  await downloadFromApi(`/reports/run-explain?runId=${encodeURIComponent(current.runId)}`)
                  addToast(t('dlq.exportSuccess'), 'success')
                } catch (error) {
                  addToast(tApiError(error) || t('dlq.exportFailed'), 'error')
                }
              }}
            >
              <Download size={12} aria-hidden="true" />
              {t('dlq.action.export')}
            </button>
          </div>
        </div>
        <DetailBlock title={t('dlq.detail.error')} value={current.errorJson} initiallyOpen />
        {detail.kind === 'ready' && (
          <>
            <DetailBlock title={t('dlq.detail.node')} value={current.nodeJson} />
            <DetailBlock title={t('dlq.detail.workflow')} value={current.workflowJson} />
          </>
        )}
      </div>

      <RunExplainChat runId={current.runId} />

      {showRecoveryDialog && detail.kind === 'ready' && (
        <Suspense fallback={null}>
          <RecoveryDialog
            dlq={current}
            onClose={() => setShowRecoveryDialog(false)}
          />
        </Suspense>
      )}
      {labSourceRunId && (
        <ReplayLabDialog
          sourceRun={{ id: labSourceRunId, status: 'failed' }}
          onClose={() => setLabSourceRunId(null)}
        />
      )}
    </section>
  )
}
