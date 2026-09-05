/**
 * Bulk credential-rotation modal — a two-step "preview → confirm" flow over
 * `POST /credentials/:name/bulk-update`. Step 1 (dry run) shows the operator
 * exactly which workflows reference the credential (the blast radius) without
 * mutating anything; step 2 commits a single `secret_ref` swap, guarded by
 * the `updatedAt` token the preview returned (`ifMatch`) so a concurrent edit
 * can't be silently clobbered. Managed values are sent once over the
 * authenticated API and never returned; legacy env references remain an
 * explicit option.
 *
 * Reuses the `run-input-*` modal CSS shell shared by the rollback / recovery
 * dialogs. Mounted per credential by `ConnectionsPanel`.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useAliveRef } from '../hooks/useAliveRef'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { AlertCircle, CheckCircle2, KeyRound, X } from 'lucide-react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { Button } from './ui/Button'
import { FormField } from './ui/Form'
import { StatusSummary } from './ui/StatusSummary'

/** One workflow touched by the rotation, with the referencing node ids. */
type AffectedWorkflow = {
  workflowId: string
  workflowName: string
  nodeIds: string[]
}

type PreviewResponse = {
  credentialName: string
  kind: string
  updatedAt: string | null
  affected: AffectedWorkflow[]
  affectedCount: number
}

/** Modal step machine: preview load → preview → rotating → done | error. */
type Step =
  | { kind: 'loading' }
  | { kind: 'preview'; affected: AffectedWorkflow[]; ifMatch: string }
  | { kind: 'rotating'; affected: AffectedWorkflow[]; ifMatch: string }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string }

type CredentialRotateModalProps = {
  credentialName: string
  onClose: () => void
}

/** Env-var NAME shape the server accepts for the new `secretRef`. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function CredentialRotateModal({ credentialName, onClose }: CredentialRotateModalProps) {
  const { t } = useT()
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [storage, setStorage] = useState<'managed' | 'environment'>('managed')
  const [newSecretValue, setNewSecretValue] = useState('')
  const [newSecretRef, setNewSecretRef] = useState('')
  const aliveRef = useAliveRef()
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const loadPreview = React.useCallback(async () => {
    setStep({ kind: 'loading' })
    try {
      const res = (await api(`/credentials/${encodeURIComponent(credentialName)}/bulk-update`, {
        method: 'POST',
        body: JSON.stringify({ dryRun: true }),
      })) as PreviewResponse
      if (!aliveRef.current) return
      if (!res.updatedAt) {
        setStep({ kind: 'error', message: t('credentialRotation.error.generic') })
        return
      }
      setStep({ kind: 'preview', affected: res.affected ?? [], ifMatch: res.updatedAt })
    } catch (error) {
      if (!aliveRef.current) return
      setStep({ kind: 'error', message: tApiError(error) || (t('credentialRotation.error.generic')) })
    }
  }, [credentialName, t])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const escapeBlocked = step.kind === 'rotating'
  useDialogFocusTrap(dialogRef, { initialFocus: true, onEscape: escapeBlocked ? undefined : onClose })

  const trimmedRef = newSecretRef.trim()
  const secretValid = storage === 'managed'
    ? newSecretValue.length > 0
    : ENV_VAR_NAME.test(trimmedRef)

  const rotate = async (affected: AffectedWorkflow[], ifMatch: string) => {
    if (!secretValid) return
    setStep({ kind: 'rotating', affected, ifMatch })
    try {
      const res = (await api(`/credentials/${encodeURIComponent(credentialName)}/bulk-update`, {
        method: 'POST',
        body: JSON.stringify({
          dryRun: false,
          ...(storage === 'managed' ? { newSecretValue } : { newSecretRef: trimmedRef }),
          ifMatch,
        }),
      })) as { affectedCount?: number }
      if (!aliveRef.current) return
      bumpPlatformVersion()
      addToast(t('credentialRotation.toast.success', { name: credentialName }), 'success')
      setStep({ kind: 'done', count: res.affectedCount ?? affected.length })
    } catch (error) {
      if (!aliveRef.current) return
      setStep({ kind: 'error', message: tApiError(error) || (t('credentialRotation.error.generic')) })
    }
  }

  const onBackdropClick = () => {
    if (step.kind === 'rotating') return
    onClose()
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credential-rotate-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <KeyRound size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{t('credentialRotation.kicker')}</div>
            <h2 id="credential-rotate-title">{t('credentialRotation.title', { name: credentialName })}</h2>
            <p className="helper-text">{t('credentialRotation.description')}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label={t('common.close')}
            disabled={step.kind === 'rotating'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body">
          {step.kind === 'loading' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              {t('credentialRotation.preview.loading')}
            </p>
          )}

          {(step.kind === 'preview' || step.kind === 'rotating') && (
            <>
              <h3 className="section-title">
                {t('credentialRotation.preview.affectedHeading', { count: step.affected.length })}
              </h3>
              {step.affected.length === 0 ? (
                <p className="helper-text">{t('credentialRotation.preview.none')}</p>
              ) : (
                <ul className="we-credential-rotate__list">
                  {step.affected.map((wf) => (
                    <li key={wf.workflowId} className="we-credential-rotate__row">
                      <strong>{wf.workflowName}</strong>
                      <span className="we-credential-rotate__nodes">
                        {t('credentialRotation.preview.nodeIds', { ids: wf.nodeIds.join(', ') })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <FormField id="credential-rotate-storage" label={t('rightPanel.credentials.storageLabel')}>
                {controlProps => (
                  <select
                    {...controlProps}
                    value={storage}
                    disabled={step.kind === 'rotating'}
                    onChange={(event) => setStorage(event.target.value as 'managed' | 'environment')}
                  >
                    <option value="managed">{t('rightPanel.credentials.storage.managed')}</option>
                    <option value="environment">{t('rightPanel.credentials.storage.environment')}</option>
                  </select>
                )}
              </FormField>
              <FormField
                id="credential-rotate-newref"
                label={storage === 'managed'
                  ? t('credentialRotation.field.newSecretValue')
                  : t('credentialRotation.field.newSecretRef')}
                hint={storage === 'managed'
                  ? t('credentialRotation.field.newSecretValueHelp')
                  : t('credentialRotation.field.newSecretRefHelp')}
                required
              >
                {controlProps => storage === 'managed' ? (
                  <input
                    {...controlProps}
                    type="password"
                    autoComplete="new-password"
                    value={newSecretValue}
                    onChange={(event) => setNewSecretValue(event.target.value)}
                    placeholder={t('rightPanel.credentials.valuePlaceholder')}
                    disabled={step.kind === 'rotating'}
                    data-testid="credential-rotate-newvalue"
                  />
                ) : (
                  <input
                    {...controlProps}
                    value={newSecretRef}
                    onChange={(event) => setNewSecretRef(event.target.value)}
                    placeholder={t('credentialRotation.field.newSecretRefPlaceholder')}
                    disabled={step.kind === 'rotating'}
                    data-testid="credential-rotate-newref"
                  />
                )}
              </FormField>
            </>
          )}

          {step.kind === 'done' && (
            <StatusSummary
              icon={<CheckCircle2 size={16} />}
              tone="success"
              role="status"
              title={t('credentialRotation.done', { count: step.count })}
            />
          )}

          {step.kind === 'error' && (
            <StatusSummary
              icon={<AlertCircle size={16} />}
              tone="danger"
              role="alert"
              title={step.message}
            />
          )}
        </div>

        <footer className="run-input-dialog__footer">
          {step.kind === 'preview' && (
            <>
              <Button variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void rotate(step.affected, step.ifMatch)}
                disabled={!secretValid}
                leadingIcon={<KeyRound size={14} />}
              >
                {t('credentialRotation.action.rotate')}
              </Button>
            </>
          )}

          {(step.kind === 'loading' || step.kind === 'rotating') && (
            <Button loading loadingLabel={t('common.working')}>
              {t('common.working')}
            </Button>
          )}

          {step.kind === 'error' && (
            <>
              <Button variant="secondary" onClick={onClose}>
                {t('common.close')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void loadPreview()}
              >
                {t('credentialRotation.action.previewAgain')}
              </Button>
            </>
          )}

          {step.kind === 'done' && (
            <Button variant="primary" onClick={onClose}>
              {t('common.close')}
            </Button>
          )}
        </footer>
      </div>
    </div>
  )
}
