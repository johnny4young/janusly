import { Fragment, useEffect, useRef, useState } from 'react'
import { useAliveRef } from '../hooks/useAliveRef'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useT } from '../i18n'
import type { DeadLetterCloseTarget } from './dead-letter-types'
import { Button } from './ui/Button'
import { FormField } from './ui/Form'
import './DeadLetterCloseDialog.css'

// Mirrors the API bound on the audited reason.
const REASON_MAX_LENGTH = 280

/** A fixed scope, not a live selection: polling cannot change what is confirmed. */
export function DeadLetterCloseDialog({ targets, onConfirm, onClose }: {
  targets: readonly DeadLetterCloseTarget[]
  onConfirm: (reason: string) => Promise<boolean>
  onClose: () => void
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reasonInput, setReasonInput] = useState('')
  const reason = reasonInput.trim()
  const busyRef = useRef(false)
  const alive = useAliveRef()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  useDialogFocusTrap(dialogRef, {
    initialFocus: reasonRef,
    onEscape: () => { if (!busyRef.current) onClose() },
  })
  useEffect(() => {
    if (busy) dialogRef.current?.focus()
    else if (failed) cancelRef.current?.focus()
  }, [busy, failed])

  const submit = async () => {
    if (busyRef.current || !reason) return
    busyRef.current = true
    setBusy(true)
    setFailed(false)
    try {
      const closed = await onConfirm(reason)
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
                <dl className="we-dlq-close__facts">
                  {[
                    [t('diff.workflow'), target.workflowName || t('dlq.copy.unknownWorkflow')],
                    [t('activity.recoveryDetail.stepLabel'), target.nodeId],
                    [t('dlq.close.occurrences'), target.occurrences],
                  ].map(([label, value]) => value != null && (
                    <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>
                  ))}
                </dl>
                <span>{t('dlq.close.failure', { id: target.id })}</span>
                {target.runId && <span>{t('dlq.close.run', { id: target.runId })}</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="we-dlq-close__reason">
          <FormField label={t('dlq.close.reason')} required>
            {controlProps => (
              <textarea {...controlProps} ref={reasonRef} rows={2} required maxLength={REASON_MAX_LENGTH}
                disabled={busy} value={reasonInput} onChange={event => setReasonInput(event.target.value)}
                data-testid="dlq-close-reason" />
            )}
          </FormField>
          {failed && <p role="alert" className="ui-field__error">{t('dlq.close.failed')}</p>}
        </div>
        <footer className="run-input-dialog__footer">
          <Button ref={cancelRef} disabled={busy} onClick={onClose} data-testid="dlq-close-cancel">{t('common.cancel')}</Button>
          <Button variant="danger" disabled={!reason} loading={busy} loadingLabel={t('common.working')}
            onClick={() => { void submit() }} data-testid="dlq-close-confirm">{t('dlq.action.resolve')}</Button>
        </footer>
      </div>
    </div>
  )
}
