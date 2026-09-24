/**
 * Failure-recovery dialog. Walks an operator through a sandbox-validated
 * apply flow:
 *
 *   1. **Idle** — explain what's about to happen, expose a "Generate
 *      suggestion" button.
 *   2. **Loading** — `POST /ai/patch-workflow` is in flight.
 *   3. **Review** — render the AI-suggested workflow as a diff against
 *      the failing version (via `WorkflowDiffView`) and surface the LLM
 *      rationale alongside.
 *   4. **Validating** — `POST /dlq/validate-fix` returns a sandbox
 *      run id; the dialog polls `GET /run?runId=…` until terminal.
 *      Validation runs are tagged `replayMode: "validation"` and don't
 *      write a `workflow_versions` row.
 *   5. **Validation-failed** — the sandbox run reached `failed` /
 *      `cancelled`; surfaces the failed node's `errorJson` plus an
 *      "Iterate" button that re-opens the suggestion flow.
 *   6. **Validated** — sandbox passed; show the updated confidence passport
 *      and require an explicit operator Apply decision.
 *   7. **Applying** — `POST /workflows/save` followed
 *      by `POST /dlq/replay` (the production replay) chained together.
 *   8. **Applied** — success ribbon + production replay run id.
 *   9. **Error** — surfaces a transport / unexpected failure. Validation
 *      errors return to the same patch for explicit review; other errors
 *      offer Retry to re-enter Idle.
 *
 * Reuses the `run-input-*` modal CSS tokens from the run-input dialog
 * (same-shape modal). The Apply button is disabled when the suggestion
 * came back as `mode: "fallback"` (no point applying a no-op).
 *
 * The controller owns the `Step` state machine, validation polling, Escape
 * guard and apply-flow callbacks. This view owns focus containment when an
 * asynchronous step replaces its footer action. Pure helpers and step bodies
 * live under `./recovery-dialog/` with explicit props.
 *
 * Used by `DeadLettersPanel.tsx` — a Suggest-fix button per row mounts
 * this dialog with the selected DLQ row.
 */
import { lazy, Suspense, useLayoutEffect, useRef } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { AlertCircle, Sparkles, X } from 'lucide-react'
import { Trans, useT } from '../i18n'
import { AppliedBody } from './recovery-dialog/AppliedBody'
import { CancellingBody } from './recovery-dialog/CancellingBody'
import { ReviewBody } from './recovery-dialog/ReviewBody'
import { ValidationFailedBody } from './recovery-dialog/ValidationFailedBody'
import { RecoveryDialogFooter } from './recovery-dialog/RecoveryDialogFooter'
import { useRecoveryDialogController, type RecoveryDialogProps } from './recovery-dialog/useRecoveryDialogController'

const PlaybookMatchCard = lazy(() => import('./recovery-dialog/PlaybookMatchCard').then((module) => ({
  default: module.PlaybookMatchCard,
})))

export function RecoveryDialog(props: RecoveryDialogProps) {
  const { t } = useT()
  const model = useRecoveryDialogController(props)
  const {
    dlq,
    onClose,
    step,
    busy,
    matchingPlaybook,
    playbookBusy,
    isClusterMode,
    clusterMemberCount,
    clusterVisibleTotal,
    clusterMembersCapped,
    safeSelectedIndex,
    selectedSuggestion,
    canApplyPatch,
    primaryRef,
    priorFailureSignature,
    setSelectedSuggestionIndex,
    loadMatchingPlaybook,
    retireMatchingPlaybook,
    onBackdropClick,
    backFromCancelling,
    submitRejection,
  } = model
  // The focus trap belongs with the dialog element it guards.
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocusTrap(dialogRef)
  // Async steps replace the focused footer action. Keep focus in the modal
  // instead of letting the browser fall back to <body>. Do not auto-focus a
  // newly available Apply button: an echoed Enter must never apply a fix.
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.contains(document.activeElement)) {
      (step.kind === 'idle' ? primaryRef.current ?? dialog : dialog).focus()
    }
  }, [step.kind, primaryRef])

  // Two-step progress for cluster recovery so the validate-1-then-replay-N flow
  // reads as staged work, not a hung dialog. Visual only — the body line below
  // each step carries the live-region announcement.
  const renderClusterSteps = (active: 'validate' | 'replay') => (
    <ol className="we-recovery-cluster-steps" aria-hidden="true" data-testid="recovery-cluster-steps">
      <li data-state={active === 'validate' ? 'active' : 'done'}>
        {t('recoveryDialog.clusterProgress.validate')}
      </li>
      <li data-state={active === 'replay' ? 'active' : 'pending'}>
        {t('recoveryDialog.clusterProgress.replay', { total: clusterMemberCount })}
      </li>
    </ol>
  )

  return (
    <div className="run-input-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-recovery-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="recovery-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{t('recoveryDialog.kicker')}</div>
            <h2 id="recovery-dialog-title">{t('recoveryDialog.titleRecover', { nodeId: dlq.nodeId, runIdShort: dlq.runId.slice(0, 8) })}</h2>
            <p className="helper-text">{t('recoveryDialog.description')}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label={t('recoveryDialog.closeAria')}
            disabled={busy}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body" aria-live="polite">
          {step.kind === 'idle' && (
            <>
            <p className="helper-text">
              {t('recoveryDialog.idle.failingNodeIs')} <code>{dlq.nodeId}</code> {t('recoveryDialog.idle.onRun')} <code>{dlq.runId.slice(0, 8)}…</code>{' '}
              {t('recoveryDialog.idle.afterAttempts', { count: dlq.attempt })}
              {isClusterMode ? (
                <>
                  {' '}{t('recoveryDialog.idle.clusterMatch')}{' '}
                  <strong>
                    {clusterMembersCapped
                      ? t('recoveryDialog.idle.clusterMatchOf', { visible: clusterMemberCount, total: clusterVisibleTotal })
                      : clusterMemberCount}
                  </strong>
                  {/* Noun only — the count is already in the <strong> above, and a
                      counted string here would print it twice. Agreement follows the
                      set being described: the capped form reads "1 of 31 open DLQ
                      entries", so the total governs, not the visible slice. */}
                  {' '}{t('recoveryDialog.idle.clusterEntriesNoun', {
                    count: clusterMembersCapped ? clusterVisibleTotal : clusterMemberCount,
                  })} —{' '}
                  {clusterMembersCapped
                    ? t('recoveryDialog.idle.clusterReplayCapped')
                    : t('recoveryDialog.idle.clusterReplayAll')}
                </>
              ) : null}
              {' '}<Trans i18nKey="recoveryDialog.idle.clickGenerate" components={{ strong: <strong /> }} />
            </p>
            {matchingPlaybook ? (
              <Suspense fallback={<p className="helper-text">{t('recoveryDialog.playbook.loading')}</p>}>
              <PlaybookMatchCard
                playbook={matchingPlaybook}
                busy={playbookBusy}
                onUse={() => void loadMatchingPlaybook()}
                onRetire={() => void retireMatchingPlaybook()}
              />
              </Suspense>
            ) : null}
            </>
          )}

          {step.kind === 'loading' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              {t('recoveryDialog.loading.analyzing')}
            </p>
          )}

          {(step.kind === 'review' || step.kind === 'validated') && selectedSuggestion && (
            <ReviewBody
              suggestion={step.suggestion}
              selected={selectedSuggestion}
              selectedIndex={step.kind === 'validated' ? step.selectedIndex : safeSelectedIndex}
              onSelectIndex={step.kind === 'validated' ? () => undefined : setSelectedSuggestionIndex}
              dlq={dlq}
              canApplyPatch={canApplyPatch}
              sandboxStatus={step.kind === 'validated' ? 'passed' : 'not_run'}
              failureSignature={priorFailureSignature}
              selectionLocked={step.kind === 'validated'}
            />
          )}

          {step.kind === 'validating' && (
            <>
              {isClusterMode && renderClusterSteps('validate')}
              <p className="helper-text we-recovery-loading" aria-live="polite">
                {isClusterMode
                  ? t('recoveryDialog.validating.clusterBody', { total: clusterMemberCount })
                  : t('recoveryDialog.validating.body')}
              </p>
            </>
          )}

          {step.kind === 'validation-failed' && (
            <ValidationFailedBody
              suggestion={step.suggestion}
              selectedIndex={step.selectedIndex}
              dlq={dlq}
              runId={step.runId}
              errorJson={step.errorJson}
              failureSignature={priorFailureSignature}
              playbookRetired={step.playbookRetired}
            />
          )}

          {step.kind === 'cancelling' && (
            <CancellingBody
              dlq={dlq}
              suggestion={step.suggestion}
              selectedIndex={step.selectedIndex}
              onSubmit={submitRejection}
              onBack={backFromCancelling}
            />
          )}

          {step.kind === 'applying' && (
            <>
              {step.mode === 'cluster' && step.total ? renderClusterSteps('replay') : null}
              <p className="helper-text we-recovery-loading" aria-live="polite">
                {step.mode === 'cluster' && step.total
                  ? t('recoveryDialog.applying.clusterBody', { total: step.total })
                  : t('recoveryDialog.applying.singleBody')}
              </p>
            </>
          )}

          {step.kind === 'applied' && (
            <AppliedBody {...step} />
          )}

          {step.kind === 'error' && (
            <div className="we-recovery-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <div>{step.message}</div>
            </div>
          )}
        </div>

        <RecoveryDialogFooter model={model} />

      </div>
    </div>
  )
}
