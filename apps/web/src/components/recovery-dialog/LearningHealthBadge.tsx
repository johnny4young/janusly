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
import { approachLabelDisplay } from './helpers'
import type { PatchApproachLabel, RecoveryFeedbackHealthSnapshot } from './types'

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
  const copy = (() => {
    switch (state) {
      case 'active':
        return {
          title: t('recoveryDialog.learning.active.title'),
          body: t('recoveryDialog.learning.active.body', { approach }),
        }
      case 'stale':
        return {
          title: t('recoveryDialog.learning.stale.title'),
          body: t('recoveryDialog.learning.stale.body', { approach, days: row?.acceptedFixAgeDays ?? feedbackHealth.windowDays }),
        }
      case 'no_accepted_fix':
        return {
          title: t('recoveryDialog.learning.noAcceptedFix.title'),
          body: t('recoveryDialog.learning.noAcceptedFix.body', { approach }),
        }
      default:
        return {
          title: t('recoveryDialog.learning.notStarted.title'),
          body: t('recoveryDialog.learning.notStarted.body', { approach }),
        }
    }
  })()

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
        <strong>{copy.title}</strong>
        <span>{copy.body}</span>
      </span>
    </div>
  )
}
