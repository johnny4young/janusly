/**
 * Read-only feedback-loop health shown beside a recovery suggestion.
 *
 * Used by: `ReviewBody` after the patch route returns its bounded
 * `feedbackHealth` side channel. This component never fetches or mutates; a
 * missing snapshot stays invisible so a best-effort health read cannot block
 * the recovery workflow.
 */

import { BrainCircuit } from 'lucide-react'
import { useT } from '../../i18n'
import { approachLabelDisplay } from './recovery-dialog-model'
import type { PatchApproachLabel, RecoveryFeedbackHealthSnapshot } from './types'
import './recovery-dialog.css'

export function LearningHealthBadge({
  feedbackHealth,
  approachLabel,
}: {
  feedbackHealth?: RecoveryFeedbackHealthSnapshot
  approachLabel: PatchApproachLabel
}) {
  const { t } = useT()
  if (!feedbackHealth) return null

  const approach = approachLabelDisplay(approachLabel)
  const row = feedbackHealth.approaches.find((candidate) => candidate.approachLabel === approachLabel)
  const state = row?.state ?? 'not_started'
  const copyKey = state === 'active' || state === 'stale' ? state
    : state === 'no_accepted_fix' ? 'noAcceptedFix' : 'notStarted'
  const title = t(`recoveryDialog.learning.${copyKey}.title`)
  const body = t(`recoveryDialog.learning.${copyKey}.body`, {
    approach, days: row?.acceptedFixAgeDays ?? feedbackHealth.windowDays,
  })

  return (
    <div
      className="we-recovery-learning-health"
      data-state={state}
      data-testid="recovery-dialog-learning-health"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="we-recovery-learning-health__icon" aria-hidden="true">
        <BrainCircuit size={15} />
      </span>
      <span className="we-recovery-learning-health__copy">
        <strong>{title}</strong>
        <span>{body}</span>
      </span>
    </div>
  )
}
