/** Operator-facing measurement card for a code-authored recovery drill. */

import { getResolvedLocale, useT } from '../../i18n'
import { formatDuration } from '../recovery-center/helpers'

export type RecoveryDrillOutcome = {
  status: 'awaiting_action' | 'replay_in_progress' | 'recovered' | 'accepted_loss' | 'measurement_incomplete'
  startedAt: string | null
  completedAt: string | null
  elapsedMs: number | null
  evidence: 'terminal_impact' | 'explicit_resolution' | null
  attemptCount: number
  latestDeadLetterId: string
  chainCapped: boolean
  recurrence: {
    status: 'not_applicable' | 'monitoring' | 'clear' | 'recurred'
    windowEndsAt: string | null
    recurredAt: string | null
  }
}

const STATUS_TONES = {
  awaiting_action: 'warning',
  replay_in_progress: 'info',
  recovered: 'success',
  accepted_loss: 'neutral',
  measurement_incomplete: 'danger',
} as const

function safeDate(iso: string | null): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Render server-derived outcome, elapsed time, and recurrence evidence. */
export function RecoveryDrillOutcomeCard({ outcome }: { outcome: RecoveryDrillOutcome }) {
  const { t } = useT()
  const startedAt = safeDate(outcome.startedAt)
  const completedAt = safeDate(outcome.completedAt)
  const elapsedMs = outcome.elapsedMs ?? (startedAt ? Math.max(0, Date.now() - startedAt.getTime()) : null)
  const elapsedLabel = outcome.completedAt ? t('dlq.drill.outcome.elapsed') : t('dlq.drill.outcome.elapsedOpen')
  const evidence = outcome.status === 'measurement_incomplete'
    ? t('dlq.drill.outcome.evidence.incomplete')
    : outcome.evidence
      ? t(`dlq.drill.outcome.evidence.${outcome.evidence}`)
      : t('dlq.drill.outcome.evidence.pending')

  let recurrence = outcome.status === 'measurement_incomplete'
    ? t('dlq.drill.outcome.recurrence.incomplete')
    : t('dlq.drill.outcome.recurrence.notApplicable')
  if (outcome.recurrence.status === 'monitoring') {
    const endsAt = safeDate(outcome.recurrence.windowEndsAt)
    recurrence = endsAt
      ? t('dlq.drill.outcome.recurrence.monitoringUntil', {
          time: endsAt.toLocaleString(getResolvedLocale()),
        })
      : t('dlq.drill.outcome.recurrence.monitoring')
  } else if (outcome.recurrence.status === 'clear') {
    recurrence = t('dlq.drill.outcome.recurrence.clear')
  } else if (outcome.recurrence.status === 'recurred') {
    const recurredAt = safeDate(outcome.recurrence.recurredAt)
    recurrence = recurredAt
      ? t('dlq.drill.outcome.recurrence.recurredAt', {
          time: recurredAt.toLocaleString(getResolvedLocale()),
        })
      : t('dlq.drill.outcome.recurrence.recurred')
  }

  return (
    <section
      className="we-recovery-drill-outcome"
      data-status={outcome.status}
      data-testid="dlq-recovery-drill-outcome"
      aria-labelledby="dlq-recovery-drill-outcome-heading"
    >
      <div className="we-recovery-drill-outcome__header">
        <div>
          <div className="section-kicker" id="dlq-recovery-drill-outcome-heading">
            {t('dlq.drill.outcome.title')}
          </div>
          <p>{evidence}</p>
        </div>
        <span className="we-pill" data-tone={STATUS_TONES[outcome.status]} role="status">
          {t(`dlq.drill.outcome.status.${outcome.status}`)}
        </span>
      </div>

      <dl className="we-recovery-drill-outcome__facts">
        <div>
          <dt>{elapsedLabel}</dt>
          <dd>{elapsedMs == null ? t('dlq.drill.outcome.unavailable') : formatDuration(elapsedMs)}</dd>
        </div>
        <div>
          <dt>{t('dlq.drill.outcome.attempts')}</dt>
          <dd>{t('dlq.drill.outcome.attemptCount', { count: outcome.attemptCount })}</dd>
        </div>
        <div>
          <dt>{t('dlq.drill.outcome.completed')}</dt>
          <dd>{completedAt ? completedAt.toLocaleString(getResolvedLocale()) : t('dlq.drill.outcome.pending')}</dd>
        </div>
      </dl>

      <p className="we-recovery-drill-outcome__recurrence" data-status={outcome.recurrence.status}>
        {recurrence}
      </p>
    </section>
  )
}
