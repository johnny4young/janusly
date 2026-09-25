/**
 * Failure-recovery dialog — Applied (success) step body.
 *
 * Used by: web/src/components/RecoveryDialog.tsx. Owns the success
 * ribbon (single-replay or cluster "Replayed N of M" + per-row errors) and
 * mounts `RecoveryDeltaCard` when the save response carried the workflow id
 * + version, falling back to ribbon-only otherwise.
 */

import { lazy, Suspense } from 'react'
import { CheckCircle2, RefreshCw } from 'lucide-react'
import { useT } from '../../i18n'
import { RecoveryDeltaCard } from '../RecoveryDeltaCard'
import type { ClusterApplyResult, PreSaveBeforeSnapshot } from './types'
import type { RecoveryPlaybookPromotionSource } from './types'

const PlaybookPromotionCard = lazy(() => import('./PlaybookPromotionCard').then((module) => ({
  default: module.PlaybookPromotionCard,
})))

export function AppliedBody({
  cluster,
  appliedWorkflowId,
  appliedVersion,
  priorFailureSignature,
  preSaveBeforeSnapshot,
  playbookPromotionSource,
  playbookUsePending,
}: {
  cluster?: ClusterApplyResult
  appliedWorkflowId?: string
  appliedVersion?: number
  priorFailureSignature?: string | null
  preSaveBeforeSnapshot?: PreSaveBeforeSnapshot | null
  playbookPromotionSource?: RecoveryPlaybookPromotionSource
  playbookUsePending?: boolean
}) {
  const { t } = useT()
  const replaySummary = cluster ? (
    <>
      {t('recoveryDialog.applied.replayedNofM', { replayed: cluster.replayed, total: cluster.replayed + cluster.failed })}
      {cluster.failed > 0 ? `; ${t('recoveryDialog.applied.numFailed', { count: cluster.failed })}` : ''}.
    </>
  ) : t('recoveryDialog.applied.dlqReplayed')
  const ribbon = (
    <div className="we-recovery-success" role="alert">
      <CheckCircle2 size={14} aria-hidden="true" />
      <div>
        <strong>{t('recoveryDialog.applied.title')}</strong>{' '}{replaySummary}
        {cluster && cluster.errors.length > 0 ? (
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

  // Tell the operator what to do next once the fix is applied — closes the
  // loop instead of leaving them on a success ribbon with no direction.
  const nextSteps = (
    <p className="helper-text we-recovery-applied-next">{t('recoveryDialog.applied.nextSteps')}</p>
  )
  const playbookResult = playbookUsePending ? (
    <section className="we-recovery-playbook-promotion we-recovery-playbook-promotion--active" data-testid="recovery-playbook-use-pending" role="status">
      <RefreshCw size={18} aria-hidden="true" />
      <div>
        <strong>{t('recoveryDialog.playbook.usePending')}</strong>
        <p className="helper-text">{t('recoveryDialog.playbook.usePendingBody')}</p>
      </div>
    </section>
  ) : playbookPromotionSource ? (
    <Suspense fallback={<p className="helper-text">{t('recoveryDialog.playbook.loading')}</p>}>
      <PlaybookPromotionCard source={playbookPromotionSource} />
    </Suspense>
  ) : null

  return (
    <div className="we-recovery-applied">
      {ribbon}
      {appliedWorkflowId && typeof appliedVersion === 'number' ? <RecoveryDeltaCard
        workflowId={appliedWorkflowId}
        afterVersion={appliedVersion}
        priorFailureSignature={priorFailureSignature ?? null}
        preSaveBeforeSnapshot={preSaveBeforeSnapshot ?? null}
      /> : null}
      {playbookResult}
      {nextSteps}
    </div>
  )
}
