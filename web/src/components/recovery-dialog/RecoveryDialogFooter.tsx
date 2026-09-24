import { Play, RefreshCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useT } from '../../i18n'
import type { RecoveryDialogModel } from './useRecoveryDialogController'

/** Shared action row; the dialog owns focus across asynchronous step changes. */
export function RecoveryDialogFooter({ model }: { model: RecoveryDialogModel }) {
  const { t } = useT()
  const { step, onClose, primaryRef, isClusterMode, clusterMemberCount, canApplyPatch, busy } = model
  const patchDecision = step.kind === 'review' || step.kind === 'validated'
  const canCancel = patchDecision || step.kind === 'validation-failed'
  let action: (() => void) | undefined
  let label: string | undefined
  let Icon: typeof Play | undefined
  switch (step.kind) {
    case 'idle':
      action = model.generateSuggestion
      label = t('recoveryDialog.footer.generate')
      Icon = Sparkles
      break
    case 'review':
      action = model.validateSuggestion
      label = isClusterMode ? t('recoveryDialog.footer.validateCluster', { count: clusterMemberCount }) : t('recoveryDialog.footer.validate')
      Icon = Play
      break
    case 'validated':
      action = () => { void model.applyAfterValidation(step.suggestion, step.selectedIndex, step.runId) }
      label = isClusterMode ? t('recoveryDialog.footer.applyCluster', { count: clusterMemberCount }) : t('recoveryDialog.footer.apply')
      Icon = Play
      break
    case 'validation-failed':
      action = model.iterateAfterValidationFailure
      label = t('recoveryDialog.footer.iterate')
      Icon = RefreshCcw
      break
    case 'error':
      action = model.retry
      label = step.suggestion ? t('recoveryDialog.footer.reviewPatch') : t('common.retry')
      break
    case 'applied':
      action = onClose
      label = t('common.close')
  }
  return (
    <footer className="run-input-dialog__footer">
      {(canCancel || step.kind === 'idle' || step.kind === 'error') && (
        <Button variant="secondary" onClick={canCancel ? model.startCancelling : onClose} disabled={busy}>
          {t(step.kind === 'error' ? 'common.close' : 'common.cancel')}
        </Button>
      )}
      {action && (
        <Button variant="primary" ref={primaryRef} onClick={action} leadingIcon={Icon && <Icon size={14} aria-hidden="true" />}
          disabled={(patchDecision && !canApplyPatch) || (step.kind === 'idle' && model.playbookBusy !== null)}
          title={step.kind === 'review' && !canApplyPatch ? t('recoveryDialog.footer.applyDisabledReason') : undefined}>
          {label}
        </Button>
      )}
      {busy && step.kind !== 'cancelling' && (
        <Button variant="secondary" disabled>{t('recoveryDialog.footer.working')}</Button>
      )}
    </footer>
  )
}
