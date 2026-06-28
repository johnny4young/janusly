/**
 * Failure-recovery dialog — Validation-failed step body.
 *
 * Used by: apps/web/src/components/RecoveryDialog.tsx. Owns the
 * sandbox-replay-failed UI: the failure banner, the failed node's error
 * detail (extracted via `pickErrorMessage`), and the `WorkflowDiffView` of
 * the rejected suggestion. The "Iterate" action lives in the parent footer.
 */

import { AlertCircle } from 'lucide-react'
import { Trans, useT } from '../../i18n'
import type { WorkflowDefinition } from '../../types'
import { WorkflowDiffView } from '../WorkflowDiffView'
import type { DeadLetter } from '../DeadLettersPanel'
import { classifyRecoveryError, pickErrorMessage } from './helpers'
import type { PatchSuggestion } from './types'

export function ValidationFailedBody({
  suggestion,
  selectedIndex,
  dlq,
  runId,
  errorJson,
}: {
  suggestion: PatchSuggestion
  selectedIndex: number
  dlq: DeadLetter
  runId: string
  errorJson: unknown
}) {
  const { t } = useT()
  const message = pickErrorMessage(errorJson)
  const category = classifyRecoveryError(errorJson)
  const selected = suggestion.suggestions[selectedIndex] ?? suggestion.suggestions[0]!
  return (
    <>
      <div className="we-recovery-warning" role="alert">
        <AlertCircle size={14} aria-hidden="true" />
        <div>
          <strong>{t('recoveryDialog.validationFailed.title')}</strong>{' '}
          <Trans
            i18nKey="recoveryDialog.validationFailed.body"
            values={{ runIdShort: runId.slice(0, 8) }}
            components={{ strong: <strong />, code: <code /> }}
          />
        </div>
      </div>
      {category ? (
        <p className="helper-text we-recovery-error-summary">
          {t(`recoveryDialog.errorSummary.${category}` as never) as string}
        </p>
      ) : null}
      {message ? (
        <pre className="we-recovery-error-detail" aria-label={t('recoveryDialog.validationFailed.errorDetailAria') as string}>
          {message}
        </pre>
      ) : null}
      <WorkflowDiffView
        before={(dlq.workflowJson ?? {}) as WorkflowDefinition}
        after={selected.workflow}
        beforeLabel={t('recoveryDialog.review.beforeLabel') as string}
        afterLabel={t('recoveryDialog.validationFailed.suggestedRejected') as string}
        aiPatchRationale={selected.rationale}
      />
    </>
  )
}
