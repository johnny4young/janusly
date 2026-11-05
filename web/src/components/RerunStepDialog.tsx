import { useEffect, useRef, useState } from 'react'

import { api } from '../api'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useT } from '../i18n'
import { tApiError } from '../i18n/server-events'
import { useWorkflowStore } from '../store'
import { Button } from './ui/Button'

type RerunPlan = {
  input: unknown
  reused: string[]
  rerun: string[]
  notRun: string[]
  sideEffects: { nodeId: string; type: string }[]
}

const post = (path: string, body: object, headers?: HeadersInit) =>
  api(path, { method: 'POST', body: JSON.stringify(body), headers })

/** Rerun one run from a step: the saved input beside the edit, and what will run again. */
export function RerunStepDialog({ runId, nodeId, onClose }: { runId: string; nodeId: string; onClose: () => void }) {
  const { t } = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  const setRunId = useWorkflowStore(state => state.setRunId)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const [plan, setPlan] = useState<RerunPlan | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  useDialogFocusTrap(dialogRef, { onEscape: busy ? undefined : onClose })

  useEffect(() => {
    post('/runs/rerun/preview', { sourceRunId: runId, nodeId }).then(
      result => setPlan(result as RerunPlan),
      (failure: unknown) => setError(tApiError(failure)),
    )
  }, [runId, nodeId])

  const submit = async () => {
    let override: unknown
    try {
      override = JSON.parse(inputRef.current?.value ?? '')
    } catch {
      setError(t('replayLab.fork.invalidJson'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const { runId: nextRunId } = await post('/runs/rerun', {
        sourceRunId: runId,
        nodeId,
        inputOverride: override,
        acknowledgedSideEffects: plan?.sideEffects.map(effect => effect.nodeId),
      }, { 'Idempotency-Key': idempotencyKey }) as { runId: string }
      setRunId(nextRunId)
      bumpPlatformVersion()
      onClose()
    } catch (failure) {
      const { code, params } = failure as { code?: string; params?: { sideEffects?: RerunPlan['sideEffects'] } }
      // The edit changed what writes: show the new list and ask again.
      if (plan && code === 'rerun_side_effects_unconfirmed' && params?.sideEffects) {
        setPlan({ ...plan, sideEffects: params.sideEffects })
      } else {
        setError(tApiError(failure))
      }
      setBusy(false)
    }
  }

  return (
    <div className="run-input-backdrop">
      <div
        ref={dialogRef}
        className="run-input-dialog we-replay-lab-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rerun-title"
      >
        <header className="run-input-dialog__header">
          <h2 id="rerun-title">{t('runWorkspace.rerun.title', { nodeId })}</h2>
        </header>
        <div className="run-input-dialog__body">
          {plan && (
            <>
              <div className="mini-grid">
                <div>
                  <span className="section-kicker">{t('runWorkspace.rerun.original')}</span>
                  <pre className="code-field">{JSON.stringify(plan.input, null, 2)}</pre>
                </div>
                <label>
                  <span className="section-kicker">{t('replayLab.fork.overrideLabel')}</span>
                  <textarea
                    className="code-field"
                    rows={10}
                    spellCheck={false}
                    ref={inputRef}
                    defaultValue={JSON.stringify(plan.input, null, 2)}
                    data-testid="rerun-input"
                  />
                </label>
              </div>
              <dl className="we-replay-lab-source-grid">
                {(['reused', 'rerun', 'notRun'] as const).map(kind => plan[kind].length > 0 && (
                  <div key={kind}>
                    <dt>{t(`runWorkspace.rerun.${kind}`)}</dt>
                    <dd>{plan[kind].join(', ')}</dd>
                  </div>
                ))}
              </dl>
              {plan.sideEffects.length > 0 && (
                <div className="ui-status-summary ui-status-summary--warning" data-testid="rerun-side-effects">
                  {t('runWorkspace.rerun.effects', { steps: plan.sideEffects.map(effect => effect.nodeId).join(', ') })}
                </div>
              )}
            </>
          )}
          {error && <div className="run-input-form-error" role="alert">{error}</div>}
        </div>
        <footer className="run-input-dialog__footer">
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!plan || busy} data-testid="rerun-submit" onClick={submit}>
            {t('runWorkspace.rerun.title', { nodeId })}
          </Button>
        </footer>
      </div>
    </div>
  )
}
