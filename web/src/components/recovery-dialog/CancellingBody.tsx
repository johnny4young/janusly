/**
 * Failure-recovery dialog — Cancel (reject) step body.
 *
 * Used by: web/src/components/RecoveryDialog.tsx. Owns the cancel UX:
 * the quick-pick reason chips, the free-text comment textarea, and the
 * Skip / Back / Submit actions. The component never talks to the API — the
 * parent's `onSubmit` handles the `/recovery/feedback` write so the dialog
 * stays the single owner of network side effects.
 */

import { useState } from 'react'
import { useT } from '../../i18n'
import type { DeadLetter } from '../dead-letter-types'
import { approachLabelDisplay } from './recovery-dialog-model'
import type { PatchSuggestion } from './types'

/**
 * Closed enum of quick-pick reasons shown as chips in the cancel UX.
 * Clicking a chip writes a feedback row with `comment = chip.id` (the
 * canonical English value, kept stable for server-side analytics) and
 * closes the dialog. The chip's display label is translated via
 * `chip.labelKey`. The operator can also type a free-text comment
 * below the chips, or skip and close with no comment.
 */
const CANCEL_REASON_CHIPS = [
  { id: 'Wrong approach', labelKey: 'recoveryDialog.cancelling.chip.wrongApproach' },
  { id: "Doesn't fix root cause", labelKey: 'recoveryDialog.cancelling.chip.doesntFix' },
  { id: 'Risky', labelKey: 'recoveryDialog.cancelling.chip.risky' },
  { id: 'Too narrow', labelKey: 'recoveryDialog.cancelling.chip.tooNarrow' },
  { id: 'Other', labelKey: 'recoveryDialog.cancelling.chip.other' },
] as const

/**
 * The cancel UX step. Operator landed here because they pressed Cancel
 * from the review or validation-failed step — they're rejecting the
 * suggestion. We capture WHY in two layers:
 *
 *   1. A row of 5 quick-pick chips (`CANCEL_REASON_CHIPS`) — clicking
 *      one auto-fills the comment and submits in a single click.
 *   2. A free-text textarea below — for reasons the chips don't cover.
 *
 * "Skip & close" submits with no comment (the operator just wanted out)
 * — the row still gets written with `accepted: false` so the count is
 * accurate, but there's no qualitative reason. "Back" returns to the
 * source step (review or validation-failed) without writing anything.
 *
 * The component itself doesn't talk to the API; the parent's `onSubmit`
 * handles the write so the dialog stays as the single owner of network
 * side effects.
 */
export function CancellingBody({
  dlq,
  suggestion,
  selectedIndex,
  onSubmit,
  onBack,
}: {
  dlq: DeadLetter
  suggestion: PatchSuggestion
  selectedIndex: number
  onSubmit: (comment: string) => void
  onBack: () => void
}) {
  const { t } = useT()
  const [comment, setComment] = useState('')
  const selected = suggestion.suggestions[selectedIndex]
  const approachLabel = selected ? approachLabelDisplay(selected.approachLabel) : (t('recoveryDialog.cancelling.thisApproach'))

  return (
    <div className="we-recovery-cancelling">
      <p className="helper-text">
        {t('recoveryDialog.cancelling.questionPrefix')} <strong>{approachLabel}</strong> {t('recoveryDialog.cancelling.questionSuffix')}{' '}
        <code>{dlq.nodeId}</code>{t('recoveryDialog.cancelling.questionTail')}
      </p>
      <div className="we-recovery-cancelling__chips" role="group" aria-label={t('recoveryDialog.cancelling.chipsAriaLabel')}>
        {CANCEL_REASON_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="we-recovery-cancelling__chip"
            onClick={() => onSubmit(chip.id)}
          >
            {t(chip.labelKey)}
          </button>
        ))}
      </div>
      <label className="we-recovery-cancelling__label" htmlFor="recovery-cancel-comment">
        {t('recoveryDialog.cancelling.commentLabel')}
      </label>
      <textarea
        id="recovery-cancel-comment"
        className="we-recovery-cancelling__textarea"
        value={comment}
        maxLength={2000}
        onChange={(event) => setComment(event.target.value)}
        rows={3}
        placeholder={t('recoveryDialog.cancelling.commentPlaceholder')}
      />
      <div className="we-recovery-cancelling__actions">
        <button
          type="button"
          className="we-recovery-cancelling__skip"
          onClick={() => onSubmit('')}
        >
          {t('recoveryDialog.cancelling.skipClose')}
        </button>
        <div className="we-recovery-cancelling__primary">
          <button type="button" className="command-button" onClick={onBack}>
            {t('recoveryDialog.cancelling.back')}
          </button>
          <button
            type="button"
            className="command-button command-button-primary"
            onClick={() => onSubmit(comment.trim())}
            disabled={comment.trim().length === 0}
          >
            {t('recoveryDialog.cancelling.submitClose')}
          </button>
        </div>
      </div>
    </div>
  )
}
