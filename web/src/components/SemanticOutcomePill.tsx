import { useT } from '../i18n'
import type { RunSummary } from '../types'

const OUTCOME_TONES: Record<
  NonNullable<RunSummary['outcomeStatus']>,
  'danger' | 'warning' | 'success' | 'neutral'
> = {
  semantic_violation: 'warning',
  semantic_quarantined: 'danger',
  semantic_recovered: 'success',
  semantic_accepted_loss: 'neutral',
}

export function SemanticOutcomePill({
  status,
  testId,
}: {
  status: NonNullable<RunSummary['outcomeStatus']>
  testId?: string
}) {
  const { t } = useT()
  return (
    <span
      className="we-pill"
      data-tone={OUTCOME_TONES[status]}
      data-outcome-status={status}
      data-testid={testId}
      title={t(`semanticOutcome.${status}.description`)}
    >
      {t(`semanticOutcome.${status}.label`)}
    </span>
  )
}
