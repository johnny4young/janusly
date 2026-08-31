/**
 * One-click workflow rollback confirmation dialog. Renders a structural
 * diff from the current version to the rollback target so the operator
 * sees exactly what will change before they commit. Reuses the
 * `run-input-*` modal CSS tokens so the surface matches the recovery
 * dialog and run-input dialog.
 *
 * State machine:
 *   - **idle**     — diff visible, primary button "Roll back".
 *   - **rolling-back** — `POST /workflows/rollback` is in flight.
 *   - **done**     — success ribbon with the new version number.
 *   - **error**    — surfaces a transport / 403 / 404 with a Close
 *                   button; primary button hides (no Retry — the
 *                   server-side transaction is forward-only and the
 *                   operator should re-pick the target from the panel).
 *
 * Used by `VersionHistoryPanel.tsx` — the per-row Rollback button mounts
 * this dialog with the selected target version.
 */

import { useEffect, useRef, useState } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { AlertCircle, CheckCircle2, RotateCcw, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { WorkflowDiffView } from './WorkflowDiffView'
import { useT } from '../i18n'
import { Button } from '@/components/ui/Button'

type VersionForRollback = {
  id: string
  version: number
  dagJson: WorkflowDefinition
}

type Step =
  | { kind: 'idle' }
  | { kind: 'rolling-back' }
  | { kind: 'done'; newVersion: number }
  | { kind: 'error'; message: string }

type RollbackConfirmDialogProps = {
  workflowId: string
  current: VersionForRollback
  target: VersionForRollback
  onClose: () => void
}

type RollbackResponse = {
  workflowId: string
  versionId: string
  version: number
  sourceVersion: number
}

export function RollbackConfirmDialog({
  workflowId,
  current,
  target,
  onClose,
}: RollbackConfirmDialogProps) {
  const { t } = useT()
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const hydrateWorkflow = useWorkflowStore((state) => state.hydrateWorkflow)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocusTrap(dialogRef)
  // Tracks whether the dialog is still mounted. Set on unmount so an
  // in-flight rollback that resolves after dismount can't push toasts,
  // hydrate the canvas, or bump the platform version against a UI the
  // operator already moved on from.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Re-focus the primary action on every step transition that has one.
  // During `rolling-back` the only footer element is a disabled
  // "Working…" button without the ref — we deliberately skip focusing
  // there to avoid moving focus to `document.body`.
  useEffect(() => {
    if (step.kind === 'rolling-back') return
    primaryRef.current?.focus()
  }, [step.kind])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (step.kind === 'rolling-back') return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, step.kind])

  const onBackdropClick = () => {
    if (step.kind === 'rolling-back') return
    onClose()
  }

  const rollback = async () => {
    setStep({ kind: 'rolling-back' })
    try {
      const result = (await api('/workflows/rollback', {
        method: 'POST',
        body: JSON.stringify({ workflowId, sourceVersionId: target.id }),
      })) as RollbackResponse
      if (!aliveRef.current) return
      hydrateWorkflow(target.dagJson)
      bumpPlatformVersion()
      addToast(t('rollback.toastSuccess', { target: target.version, newVersion: result.version }), 'success')
      setStep({ kind: 'done', newVersion: result.version })
    } catch (error) {
      if (!aliveRef.current) return
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : t('rollback.failed'),
      })
    }
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rollback-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <RotateCcw size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{t('rollback.kicker')}</div>
            <h2 id="rollback-dialog-title">{t('rollback.title', { version: target.version })}</h2>
            <p className="helper-text">
              {t('rollback.description', { target: target.version, current: current.version })}
            </p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label={t('rollback.close')}
            disabled={step.kind === 'rolling-back'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body">
          {step.kind === 'rolling-back' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              {t('rollback.saving', { version: target.version })}
            </p>
          )}

          {step.kind === 'done' && (
            <div className="we-recovery-warning" role="status">
              <CheckCircle2 size={14} aria-hidden="true" />
              <div>
                {t('rollback.success', { target: target.version, newVersion: step.newVersion })}
              </div>
            </div>
          )}

          {step.kind === 'error' && (
            <div className="we-recovery-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <div>{step.message}</div>
            </div>
          )}

          {(step.kind === 'idle' || step.kind === 'rolling-back') && (
            <WorkflowDiffView
              before={current.dagJson}
              after={target.dagJson}
              beforeLabel={t('rollback.beforeLabel', { version: current.version })}
              afterLabel={t('rollback.afterLabel', { version: target.version })}
            />
          )}
        </div>

        <footer className="run-input-dialog__footer">
          {step.kind === 'idle' && (
            <>
              <Button variant="secondary" type="button"  onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary"
                type="button"
                ref={primaryRef}

                onClick={rollback}
              >
                <RotateCcw size={14} aria-hidden="true" />
                <span>{t('rollback.action')}</span>
              </Button>
            </>
          )}

          {step.kind === 'rolling-back' && (
            <Button variant="secondary" type="button"  disabled>
              {t('common.working')}
            </Button>
          )}

          {(step.kind === 'done' || step.kind === 'error') && (
            <Button variant="primary"
              type="button"
              ref={primaryRef}

              onClick={onClose}
            >
              {t('common.close')}
            </Button>
          )}
        </footer>
      </div>
    </div>
  )
}
