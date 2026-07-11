/**
 * Failure-recovery dialog — Applied (success) step body.
 *
 * Used by: apps/web/src/components/RecoveryDialog.tsx. Owns the success
 * ribbon (single-replay or cluster "Replayed N of M" + per-row errors) and
 * mounts `RecoveryDeltaCard` when the save response carried the workflow id
 * + version, falling back to ribbon-only otherwise.
 */

import { lazy, Suspense } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { useT } from '../../i18n'
import { RecoveryDeltaCard } from '../RecoveryDeltaCard'
import { formatDowntime } from '../recovery-center/helpers'
import type { ClusterApplyResult, PreSaveBeforeSnapshot } from './types'
import type { RecoveryPlaybookPromotionSource, RecoveryPlaybookSummary } from './types'

const PlaybookPromotionCard = lazy(() => import('./PlaybookPromotionCard').then((module) => ({
  default: module.PlaybookPromotionCard,
})))

export function AppliedBody({
  runId,
  cluster,
  appliedWorkflowId,
  appliedVersion,
  priorFailureSignature,
  preSaveBeforeSnapshot,
  playbookPromotionSource,
  appliedPlaybook,
}: {
  runId?: string
  cluster?: ClusterApplyResult
  appliedWorkflowId?: string
  appliedVersion?: number
  priorFailureSignature?: string | null
  preSaveBeforeSnapshot?: PreSaveBeforeSnapshot | null
  playbookPromotionSource?: RecoveryPlaybookPromotionSource
  appliedPlaybook?: RecoveryPlaybookSummary
}) {
  const { t } = useT()
  const ribbon = cluster ? (
    (() => {
      const total = cluster.replayed + cluster.failed
      // Name the downtime this apply just ended.
      // Absent/0 downtimeEndedMs (legacy rows, zero-clock edge) → no line,
      // never a NaN string.
      const showDowntime = cluster.replayed > 0
        && typeof cluster.downtimeEndedMs === 'number'
        && Number.isFinite(cluster.downtimeEndedMs)
        && cluster.downtimeEndedMs > 0
      return (
        <div className="we-recovery-success" role="alert">
          <CheckCircle2 size={14} aria-hidden="true" />
          <div>
            <strong>{t('recoveryDialog.applied.title')}</strong>
            {' '}{t('recoveryDialog.applied.replayedNofM', { replayed: cluster.replayed, total })}
            {cluster.failed > 0 ? `; ${t('recoveryDialog.applied.numFailed', { count: cluster.failed })}` : ''}.
            {showDowntime && (
              <p className="we-recovery-cluster-celebration" data-testid="cluster-recovered-line">
                {t('recoveryDialog.clusterRecovered', {
                  count: cluster.replayed,
                  duration: formatDowntime(cluster.downtimeEndedMs as number),
                })}
              </p>
            )}
            {cluster.errors.length > 0 ? (
              <details className="we-recovery-cluster-errors">
                <summary>{t('recoveryDialog.applied.showRowErrors', { count: cluster.errors.length })}</summary>
                <ul>
                  {cluster.errors.map((entry) => (
                    <li key={entry.deadLetterId}>
                      <code>{entry.deadLetterId.slice(0, 12)}…</code>
                      <span className="helper-text">{entry.error}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      )
    })()
  ) : (
    <div className="we-recovery-success" role="alert">
      <CheckCircle2 size={14} aria-hidden="true" />
      <div>
        <strong>{t('recoveryDialog.applied.title')}</strong>{' '}
        {runId
          ? t('recoveryDialog.applied.runStarted', { runIdShort: runId.slice(0, 8) })
          : t('recoveryDialog.applied.dlqReplayed')}
      </div>
    </div>
  )

  // Tell the operator what to do next once the fix is applied — closes the
  // loop instead of leaving them on a success ribbon with no direction.
  const nextSteps = (
    <p className="helper-text we-recovery-applied-next">{t('recoveryDialog.applied.nextSteps')}</p>
  )
  const playbookResult = appliedPlaybook ? (
    <section className="we-recovery-playbook-promotion we-recovery-playbook-promotion--active" data-testid="recovery-playbook-use-recorded" role="status">
      <CheckCircle2 size={18} aria-hidden="true" />
      <div>
        <strong>{t('recoveryDialog.playbook.useRecorded')}</strong>
        <p className="helper-text">{t('recoveryDialog.playbook.useRecordedBody', { count: appliedPlaybook.successfulUses })}</p>
      </div>
    </section>
  ) : playbookPromotionSource ? (
    <Suspense fallback={<p className="helper-text">{t('recoveryDialog.playbook.loading')}</p>}>
      <PlaybookPromotionCard source={playbookPromotionSource} />
    </Suspense>
  ) : null

  // Mount the delta card alongside the ribbon when the save response
  // gave us the workflow id + version. Defensive fall-through to
  // ribbon-only when the save route returned an unexpected shape.
  if (!appliedWorkflowId || typeof appliedVersion !== 'number') {
    return (
      <div className="we-recovery-applied">
        {ribbon}
        {playbookResult}
        {nextSteps}
      </div>
    )
  }

  return (
    <div className="we-recovery-applied">
      {ribbon}
      <RecoveryDeltaCard
        workflowId={appliedWorkflowId}
        afterVersion={appliedVersion}
        priorFailureSignature={priorFailureSignature ?? null}
        preSaveBeforeSnapshot={preSaveBeforeSnapshot ?? null}
      />
      {playbookResult}
      {nextSteps}
    </div>
  )
}
