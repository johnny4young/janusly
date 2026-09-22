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
 *   - **done**     — close and announce the new version in a success toast.
 *   - **error**    — surfaces a transport / 403 / 404 with a Close
 *                   button; primary button hides (no Retry — the
 *                   server-side transaction is forward-only and the
 *                   operator should re-pick the target from the panel).
 *
 * Used by `VersionHistoryPanel.tsx` — the per-row Rollback button mounts
 * this dialog with the selected target version.
 */

import { useEffect, useEffectEvent, useState, useRef } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { RotateCcw, X } from 'lucide-react'
import { api } from '../api'
import { parseWorkflowRollbackReceipt } from '../lib/authoring-contract'
import { ownCanvas } from '../lib/canvas-authority'
import { sessionCan } from '../identity-context'
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
  | { kind: 'done' }
  | { kind: 'error'; message: string }

type RollbackConfirmDialogProps = {
  workflowId: string
  current: VersionForRollback
  target: VersionForRollback
  onClose: () => void
}

export function RollbackConfirmDialog({
  workflowId,
  current,
  target,
  onClose,
}: RollbackConfirmDialogProps) {
  const { t } = useT()
  const { bumpPlatformVersion, hydrateWorkflow, addToast } = useWorkflowStore.getState()
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const pair = JSON.stringify([workflowId, current.id, current.version, target.id, target.version])
  const [snapshot] = useState(() => structuredClone({ pair, current, target,
    dirty: useWorkflowStore.getState().workflowDirty }))
  const request = useRef<AbortController | null>(null)
  const stale = pair !== snapshot.pair
    || !sessionCan(useWorkflowStore.getState().identityContext, 'workflows.write')
    || (snapshot.target.dagJson.id !== undefined && snapshot.target.dagJson.id !== workflowId)

  const invalidate = useEffectEvent(() => {
    setStep({ kind: 'done' })
    onClose()
  })
  useEffect(() => {
    if (stale) { invalidate(); return }
    const controller = ownCanvas(invalidate)
    request.current = controller
    return () => controller.abort()
  }, [stale])

  const busy = step.kind === 'rolling-back'
  const failed = step.kind === 'error'
  const dismiss = busy ? undefined : onClose
  useDialogFocusTrap(dialogRef, { onEscape: dismiss })

  const rollback = async () => {
    const controller = request.current
    if (stale || !controller || controller.signal.aborted) return
    request.current = null
    setStep({ kind: 'rolling-back' })
    try {
      const result = await api('/workflows/rollback', { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ workflowId, sourceVersionId: snapshot.target.id }) })
      if (controller.signal.aborted) return
      const version = parseWorkflowRollbackReceipt(result, workflowId, snapshot.current, snapshot.target)
      if (!version) throw new Error(t('rollback.failed'))
      // Release the lease before our own synchronous canvas replacement.
      controller.abort()
      hydrateWorkflow({ ...snapshot.target.dagJson, id: workflowId }, { version })
      bumpPlatformVersion()
      addToast(t('rollback.toastSuccess', { target: snapshot.target.version, newVersion: version.version }), 'success')
      setStep({ kind: 'done' })
      onClose()
    } catch (error) {
      if (controller.signal.aborted) return
      setStep({ kind: 'error', message: error instanceof Error ? error.message : t('rollback.failed') })
    }
  }

  if (stale || step.kind === 'done') return null

  return (
    <div className="run-input-backdrop" onClick={dismiss}>
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
            <h2 id="rollback-dialog-title">{t('rollback.title', { version: target.version })}</h2>
            <p className="helper-text">
              {t('rollback.description', { target: target.version, current: current.version })}
            </p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label={t('rollback.close')} disabled={busy}>
            <X size={16} aria-hidden="true" />
          </Button>
        </header>

        <div className="run-input-dialog__body">
          {step.kind === 'idle' && snapshot.dirty && <p className="we-recovery-warning">{t('unsavedGuard.body')}</p>}


          {failed && (
            <div className="we-recovery-error" role="alert">
              {step.message}
            </div>
          )}

          {!failed && (
            <WorkflowDiffView
              before={snapshot.current.dagJson}
              after={snapshot.target.dagJson}
              beforeLabel={t('rollback.beforeLabel', { version: current.version })}
              afterLabel={t('rollback.afterLabel', { version: target.version })}
            />
          )}
        </div>

        <footer className="run-input-dialog__footer" aria-live="polite">
          {step.kind === 'idle' && <Button autoFocus onClick={onClose}>{t('common.cancel')}</Button>}
          <Button
            key={failed ? 'close' : 'submit'}
            autoFocus={failed}
            variant={failed ? 'primary' : 'danger'}
            onClick={failed ? onClose : rollback}
            loading={busy}
            loadingLabel={t('common.working')}
          >
            {failed ? t('common.close') : t('rollback.action')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
