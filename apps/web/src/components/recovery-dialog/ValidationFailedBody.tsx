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
import { RecoveryPassportCard } from './RecoveryPassportCard'
import type { PatchSuggestion } from './types'

export function ValidationFailedBody({
  suggestion,
  selectedIndex,
  dlq,
  runId,
  errorJson,
  failureSignature,
  playbookRetired = false,
}: {
  suggestion: PatchSuggestion
  selectedIndex: number
  dlq: DeadLetter
  runId: string
  errorJson: unknown
  failureSignature: string
  playbookRetired?: boolean
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
      {playbookRetired ? (
        <div className="we-recovery-playbook-regression" data-testid="recovery-playbook-regression" role="status">
          <strong>{t('recoveryDialog.playbook.regressionTitle')}</strong>
          <span>{t('recoveryDialog.playbook.regressionBody')}</span>
        </div>
      ) : null}
      {category ? (
        <p className="helper-text we-recovery-error-summary">
          {t(`recoveryDialog.errorSummary.${category}` as never)}
        </p>
      ) : null}
      {message ? (
        <pre className="we-recovery-error-detail" aria-label={t('recoveryDialog.validationFailed.errorDetailAria')}>
          {message}
        </pre>
      ) : null}
      <RecoveryPassportCard
        dlq={dlq}
        suggestion={suggestion}
        selected={selected}
        actionable={true}
        sandboxStatus="failed"
        failureSignature={failureSignature}
      />
      <WorkflowDiffView
        before={(dlq.workflowJson ?? {}) as WorkflowDefinition}
        after={selected.workflow}
        beforeLabel={t('recoveryDialog.review.beforeLabel')}
        afterLabel={t('recoveryDialog.validationFailed.suggestedRejected')}
        aiPatchRationale={selected.rationale}
      />
    </>
  )
}
