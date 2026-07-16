/**
 * Bulk credential-rotation modal — a two-step "preview → confirm" flow over
 * `POST /credentials/:name/bulk-update`. Step 1 (dry run) shows the operator
 * exactly which workflows reference the credential (the blast radius) without
 * mutating anything; step 2 commits a single `secret_ref` swap, guarded by
 * the `updatedAt` token the preview returned (`ifMatch`) so a concurrent edit
 * can't be silently clobbered — a stale token surfaces as a conflict and the
 * operator re-previews.
 *
 * The secret VALUE never touches this component, and the route never echoes
 * the env-var NAME back — the operator types the new env-var name here (they
 * already know it) and the modal only displays the affected-workflow list.
 *
 * Reuses the `run-input-*` modal CSS shell shared by the rollback / recovery
 * dialogs. Mounted per-credential by `CredentialsPanel` (in `RightPanel`).
 */

import React, { useEffect, useRef, useState } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { AlertCircle, CheckCircle2, KeyRound, X } from 'lucide-react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'

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
  const [newSecretRef, setNewSecretRef] = useState('')
  const aliveRef = useRef(true)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocusTrap(dialogRef, { initialFocus: true })

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (step.kind === 'rotating') return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, step.kind])

  const trimmedRef = newSecretRef.trim()
  const refValid = ENV_VAR_NAME.test(trimmedRef)

  const rotate = async (affected: AffectedWorkflow[], ifMatch: string) => {
    if (!refValid) return
    setStep({ kind: 'rotating', affected, ifMatch })
    try {
      const res = (await api(`/credentials/${encodeURIComponent(credentialName)}/bulk-update`, {
        method: 'POST',
        body: JSON.stringify({ dryRun: false, newSecretRef: trimmedRef, ifMatch }),
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
              <label className="field-label" htmlFor="credential-rotate-newref">
                {t('credentialRotation.field.newSecretRef')}
              </label>
              <input
                id="credential-rotate-newref"
                className="text-field"
                value={newSecretRef}
                onChange={(event) => setNewSecretRef(event.target.value)}
                placeholder={t('credentialRotation.field.newSecretRefPlaceholder')}
                disabled={step.kind === 'rotating'}
                data-testid="credential-rotate-newref"
              />
              <span className="helper-text">{t('credentialRotation.field.newSecretRefHelp')}</span>
            </>
          )}

          {step.kind === 'done' && (
            <div className="we-recovery-warning" role="status">
              <CheckCircle2 size={14} aria-hidden="true" />
              <div>{t('credentialRotation.done', { count: step.count })}</div>
            </div>
          )}

          {step.kind === 'error' && (
            <div className="we-recovery-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <div>{step.message}</div>
            </div>
          )}
        </div>

        <footer className="run-input-dialog__footer">
          {step.kind === 'preview' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="command-button command-button-primary"
                onClick={() => void rotate(step.affected, step.ifMatch)}
                disabled={!refValid}
              >
                <KeyRound size={14} aria-hidden="true" />
                <span>{t('credentialRotation.action.rotate')}</span>
              </button>
            </>
          )}

          {(step.kind === 'loading' || step.kind === 'rotating') && (
            <button type="button" className="command-button" disabled>
              {t('common.working')}
            </button>
          )}

          {step.kind === 'error' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                {t('common.close')}
              </button>
              <button
                type="button"
                className="command-button command-button-primary"
                onClick={() => void loadPreview()}
              >
                {t('credentialRotation.action.previewAgain')}
              </button>
            </>
          )}

          {step.kind === 'done' && (
            <button type="button" className="command-button command-button-primary" onClick={onClose}>
              {t('common.close')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
