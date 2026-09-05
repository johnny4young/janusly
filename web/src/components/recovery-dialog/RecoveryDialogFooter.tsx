import { Play, RefreshCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useT } from '../../i18n'
import type { RecoveryDialogModel } from './useRecoveryDialogController'

// The dialog's action row: one pair of buttons per step, the primary one
// focused on mount so keyboard users can hit Enter.
export function RecoveryDialogFooter({ model }: { model: RecoveryDialogModel }) {
  const { t } = useT()
  const {
    step,
    onClose,
    primaryRef,
    isClusterMode,
    clusterMemberCount,
    canApplyPatch,
    generateSuggestion,
    validateSuggestion,
    applyAfterValidation,
    startCancelling,
    iterateAfterValidationFailure,
    retry,
  } = model
  return (
        <footer className="run-input-dialog__footer">
          {step.kind === 'idle' && (
            <>
              <Button variant="secondary" type="button"  onClick={onClose}>
                {t('recoveryDialog.footer.cancel')}
              </Button>
              <Button variant="primary"
                type="button"
                ref={primaryRef}

                onClick={generateSuggestion}
              >
                <Sparkles size={14} aria-hidden="true" />
                <span>{t('recoveryDialog.footer.generate')}</span>
              </Button>
            </>
          )}

          {step.kind === 'review' && (
            <>
              <Button variant="secondary"
                type="button"

                onClick={startCancelling}
              >
                {t('recoveryDialog.footer.cancel')}
              </Button>
              <Button variant="primary"
                type="button"
                ref={primaryRef}

                onClick={validateSuggestion}
                disabled={!canApplyPatch}
                title={!canApplyPatch ? (t('recoveryDialog.footer.applyDisabledReason')) : undefined}
              >
                <Play size={14} aria-hidden="true" />
                <span>
                  {isClusterMode
                    ? t('recoveryDialog.footer.validateCluster', { count: clusterMemberCount })
                    : t('recoveryDialog.footer.validate')}
                </span>
              </Button>
            </>
          )}

          {step.kind === 'validated' && (
            <>
              <Button variant="secondary"
                type="button"

                onClick={startCancelling}
              >
                {t('recoveryDialog.footer.cancel')}
              </Button>
              <Button variant="primary"
                type="button"
                ref={primaryRef}

                onClick={() => void applyAfterValidation(step.suggestion, step.selectedIndex, step.runId)}
                disabled={!canApplyPatch}
              >
                <Play size={14} aria-hidden="true" />
                <span>{isClusterMode
                  ? t('recoveryDialog.footer.applyCluster', { count: clusterMemberCount })
                  : t('recoveryDialog.footer.apply')}</span>
              </Button>
            </>
          )}

          {step.kind === 'validation-failed' && (
            <>
              <Button variant="secondary"
                type="button"

                onClick={startCancelling}
              >
                {t('recoveryDialog.footer.cancel')}
              </Button>
              <Button variant="primary"
                type="button"
                ref={primaryRef}

                onClick={iterateAfterValidationFailure}
              >
                <RefreshCcw size={14} aria-hidden="true" />
                <span>{t('recoveryDialog.footer.iterate')}</span>
              </Button>
            </>
          )}

          {step.kind === 'error' && (
            <>
              <Button variant="secondary" type="button"  onClick={onClose}>
                {t('recoveryDialog.footer.close')}
              </Button>
              <Button variant="primary"
                type="button"
                ref={primaryRef}

                onClick={retry}
              >
                {t('recoveryDialog.footer.retry')}
              </Button>
            </>
          )}

          {step.kind === 'applied' && (
            <Button variant="primary"
              type="button"
              ref={primaryRef}

              onClick={onClose}
            >
              {t('recoveryDialog.footer.close')}
            </Button>
          )}

          {(step.kind === 'loading' || step.kind === 'applying' || step.kind === 'validating') && (
            <Button variant="secondary" type="button"  disabled>
              {t('recoveryDialog.footer.working')}
            </Button>
          )}
        </footer>
  )
}
