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

import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, RotateCcw, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { WorkflowDiffView } from './WorkflowDiffView'

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
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const hydrateWorkflow = useWorkflowStore((state) => state.hydrateWorkflow)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const primaryRef = useRef<HTMLButtonElement | null>(null)
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
      addToast(`Rolled back to v${target.version} as v${result.version}`, 'success')
      setStep({ kind: 'done', newVersion: result.version })
    } catch (error) {
      if (!aliveRef.current) return
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Rollback failed',
      })
    }
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdropClick}>
      <div
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
            <div className="section-kicker">Roll back workflow</div>
            <h2 id="rollback-dialog-title">Roll back to v{target.version}?</h2>
            <p className="helper-text">
              This creates a new version with v{target.version} as its content. Your history stays intact —
              v{current.version} and any later versions remain accessible.
            </p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label="Close rollback dialog"
            disabled={step.kind === 'rolling-back'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body">
          {step.kind === 'rolling-back' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              Saving v{target.version} as the new latest version…
            </p>
          )}

          {step.kind === 'done' && (
            <div className="we-recovery-warning" role="status">
              <CheckCircle2 size={14} aria-hidden="true" />
              <div>
                Rolled back to v{target.version} as v{step.newVersion}. The canvas now shows the rolled-back
                content.
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
              beforeLabel={`v${current.version} (current)`}
              afterLabel={`v${target.version} (rolling back to)`}
            />
          )}
        </div>

        <footer className="run-input-dialog__footer">
          {step.kind === 'idle' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="command-button command-button-primary"
                onClick={rollback}
              >
                <RotateCcw size={14} aria-hidden="true" />
                <span>Roll back</span>
              </button>
            </>
          )}

          {step.kind === 'rolling-back' && (
            <button type="button" className="command-button" disabled>
              Working…
            </button>
          )}

          {(step.kind === 'done' || step.kind === 'error') && (
            <button
              type="button"
              ref={primaryRef}
              className="command-button command-button-primary"
              onClick={onClose}
            >
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
