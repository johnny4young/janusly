import { useEffect, useRef, useState } from 'react'
import { useAliveRef } from '../hooks/useAliveRef'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useT } from '../i18n'
import { Button } from './ui/Button'
import './DeadLetterCloseDialog.css'

export type DeadLetterCloseTarget = {
  id: string
  workflowName?: string | null
  runId?: string
  nodeId?: string
}

/** A fixed scope, not a live selection: polling cannot change what is confirmed. */
export function DeadLetterCloseDialog({ targets, onConfirm, onClose }: {
  targets: readonly DeadLetterCloseTarget[]
  onConfirm: () => Promise<boolean>
  onClose: () => void
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const busyRef = useRef(false)
  const alive = useAliveRef()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useDialogFocusTrap(dialogRef, {
    initialFocus: cancelRef,
    onEscape: () => { if (!busyRef.current) onClose() },
  })
  useEffect(() => {
    if (busy) dialogRef.current?.focus()
    else if (failed) cancelRef.current?.focus()
  }, [busy, failed])

  const submit = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setFailed(false)
    try {
      const closed = await onConfirm()
      if (!alive.current) return
      if (closed) onClose()
      else setFailed(true)
    } catch {
      if (alive.current) setFailed(true)
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  return (
    <div className="run-input-backdrop" onClick={() => { if (!busyRef.current) onClose() }}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-dlq-close"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dlq-close-title"
        aria-describedby="dlq-close-consequence"
        aria-busy={busy} tabIndex={-1} onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          // Native disabled controls leave no tab stops during submission.
          if (busyRef.current && event.key === 'Tab') {
            event.preventDefault()
            dialogRef.current?.focus()
          }
        }}>
        <header className="run-input-dialog__header">
          <div className="run-input-dialog__heading">
            <h2 id="dlq-close-title">{t('dlq.close.title', { count: targets.length })}</h2>
            <p id="dlq-close-consequence" className="helper-text">{t('dlq.close.consequence')}</p>
          </div>
        </header>
        <div className="run-input-dialog__body">
          <ul className="we-dlq-close__targets" aria-label={t('dlq.close.scope')}>
            {targets.map(target => (
              <li key={target.id}>
                <strong>{target.workflowName || t('dlq.copy.unknownWorkflow')}</strong>
                <span>{t('dlq.close.failure', { id: target.id })}</span>
                {target.runId && <span>{t('dlq.close.run', { id: target.runId })}</span>}
                {target.nodeId && <span>{t('dlq.close.node', { id: target.nodeId })}</span>}
              </li>
            ))}
          </ul>
          {failed && <p role="alert" className="ui-field__error">{t('dlq.close.failed')}</p>}
        </div>
        <footer className="run-input-dialog__footer">
          <Button ref={cancelRef} disabled={busy} onClick={onClose} data-testid="dlq-close-cancel">{t('common.cancel')}</Button>
          <Button variant="danger" loading={busy} loadingLabel={t('common.working')}
            onClick={() => { void submit() }} data-testid="dlq-close-confirm">{t('dlq.action.resolve')}</Button>
        </footer>
      </div>
    </div>
  )
}
