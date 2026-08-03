import { ShieldCheck } from 'lucide-react'

import { useT } from '../i18n'

type RolloutStatus = 'active' | 'promoted' | 'rolled_back' | 'cancelled'

export function WorkflowRolloutStatus({
  status,
  trafficPercent,
  minimumSampleSize,
  minimumSuccessRatePercent,
  baselineVersion,
  canaryVersion,
  baselineRuns,
  canaryRuns,
  canarySuccessRate,
  readOnly,
  mutating,
  onDecide,
}: {
  status: RolloutStatus
  trafficPercent: number
  minimumSampleSize: number
  minimumSuccessRatePercent: number
  baselineVersion?: number
  canaryVersion?: number
  baselineRuns: number
  canaryRuns: number
  canarySuccessRate: number | null
  readOnly: boolean
  mutating: boolean
  onDecide: (decision: 'promote' | 'rollback') => void
}) {
  const { t } = useT()
  return (
    <div className="we-rollout-panel__status" data-testid="workflow-rollout-status">
      <div className="we-rollout-panel__versions">
        <span>{t('workflowRollout.baselineVersion', { version: baselineVersion ?? '?' })}</span>
        <strong>{t('workflowRollout.trafficToCanary', { percent: trafficPercent, version: canaryVersion ?? '?' })}</strong>
      </div>
      <progress
        className="we-rollout-panel__progress"
        max={100}
        value={trafficPercent}
        aria-label={t('workflowRollout.trafficProgress')}
      />
      <div className="we-rollout-panel__metrics">
        <div><span>{t('workflowRollout.baselineRuns')}</span><strong>{baselineRuns}</strong></div>
        <div><span>{t('workflowRollout.canaryRuns')}</span><strong>{canaryRuns}</strong></div>
        <div>
          <span>{t('workflowRollout.canarySuccess')}</span>
          <strong>{canarySuccessRate === null ? '—' : `${canarySuccessRate.toFixed(1)}%`}</strong>
        </div>
        <div>
          <span>{t('workflowRollout.guardrail')}</span>
          <strong>≥ {minimumSuccessRatePercent}% / {minimumSampleSize}</strong>
        </div>
      </div>
      {!readOnly && status === 'active' && (
        <div className="we-rollout-panel__actions">
          <button
            type="button"
            className="command-button command-button-primary"
            disabled={mutating}
            onClick={() => onDecide('promote')}
          >
            {t('workflowRollout.promote')}
          </button>
          <button
            type="button"
            className="command-button command-button-danger"
            disabled={mutating}
            onClick={() => onDecide('rollback')}
          >
            {t('workflowRollout.rollback')}
          </button>
        </div>
      )}
      {status !== 'active' && (
        <p className="we-rollout-panel__decision">
          <ShieldCheck size={15} aria-hidden="true" />
          {t(`workflowRollout.decision.${status}`)}
        </p>
      )}
    </div>
  )
}
