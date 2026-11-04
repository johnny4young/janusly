import { AlertCircle, AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { api } from '../api'
import { referencingWorkflowIds } from '../connections-inventory'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useT } from '../i18n'
import { AffectedWorkflowList, type WorkflowLabels } from './AffectedWorkflowList'
import { Button } from './ui/Button'
import { FormField } from './ui/Form'

// A hung health read must reach the fail-safe path instead of blocking the dialog.
const AFFECTED_WORKFLOWS_TIMEOUT_MS = 10_000

export function CredentialRevokeDialog({
  credentialName,
  workflows,
  onClose,
  onRevoke,
}: {
  credentialName: string
  workflows: WorkflowLabels
  onClose: () => void
  onRevoke: (name: string) => Promise<boolean>
}) {
  const { t } = useT()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  // Null means the references could not be read, which is never "no workflows".
  const [affectedIds, setAffectedIds] = useState<string[] | null | 'loading'>('loading')
  const [typedName, setTypedName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Cancel owns focus so a stray Enter cannot revoke while there is nothing to type.
  useDialogFocusTrap(dialogRef, {
    initialFocus: cancelRef,
    onEscape: submitting ? undefined : onClose,
  })

  useEffect(() => {
    api('/credentials/health', { signal: AbortSignal.timeout(AFFECTED_WORKFLOWS_TIMEOUT_MS) })
      .then((response) => referencingWorkflowIds(response, credentialName))
      .catch(() => null)
      .then(setAffectedIds)
  }, [credentialName])

  const requiresTypedName = affectedIds === null || (affectedIds !== 'loading' && affectedIds.length > 0)
  const canRevoke = affectedIds !== 'loading'
    && !submitting
    && (!requiresTypedName || typedName.trim() === credentialName)

  const revoke = async () => {
    if (!canRevoke) return
    // Every control disables while busy; the root keeps focus inside the trap for a retry.
    dialogRef.current?.focus()
    setSubmitting(true)
    const revoked = await onRevoke(credentialName)
    setSubmitting(false)
    if (revoked) onClose()
  }

  return (
    <div className="run-input-backdrop" onClick={() => { if (!submitting) onClose() }}>
      <div
        ref={dialogRef}
        className="run-input-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="credential-revoke-title"
        aria-describedby="credential-revoke-consequence"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <AlertTriangle size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <h2 id="credential-revoke-title">{t('rightPanel.credentials.revokeTitle', { name: credentialName })}</h2>
            <p id="credential-revoke-consequence" className="helper-text">
              {t('rightPanel.credentials.revokeConsequence')}
            </p>
          </div>
        </header>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void revoke()
          }}
        >
          <div className="run-input-dialog__body">
            {affectedIds === 'loading' && (
              <p className="helper-text" aria-live="polite">{t('credentialRotation.preview.loading')}</p>
            )}
            {affectedIds === null && (
              <p className="we-connections-inventory__notice" role="status">
                <AlertCircle size={14} aria-hidden="true" />
                {t('rightPanel.credentials.revokeAffectedUnavailable')}
              </p>
            )}
            {affectedIds !== null && affectedIds !== 'loading' && (
              <AffectedWorkflowList workflowIds={affectedIds} workflows={workflows} />
            )}
            {requiresTypedName && (
              <FormField
                id="credential-revoke-typed-name"
                label={t('rightPanel.credentials.revokeTypeToConfirm', { name: credentialName })}
              >
                {(controlProps) => (
                  <input
                    {...controlProps}
                    autoFocus
                    value={typedName}
                    onChange={(event) => setTypedName(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={submitting}
                    data-testid="credential-revoke-typed-name"
                  />
                )}
              </FormField>
            )}
          </div>

          <footer className="run-input-dialog__footer">
            <Button
              ref={cancelRef}
              variant="secondary"
              onClick={onClose}
              disabled={submitting}
              data-testid="credential-revoke-cancel"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={!canRevoke}
              loading={submitting}
              loadingLabel={t('common.working')}
              data-testid="credential-revoke-confirm"
            >
              {t('rightPanel.credentials.revoke')}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  )
}
