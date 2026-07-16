/**
 * Replay Lab Fork dialog — opens a sandbox replay starting at a chosen
 * node of a completed run. The companion to `ReplayLabDialog.tsx` (which
 * replays the whole run). The fork variant takes one extra input from
 * the operator: a JSON override for the fork node's input. Predecessors
 * keep their original output, the fork node runs with the override,
 * and downstream runs through the dryRun gate.
 *
 * State machine:
 *
 *   1. **Idle** — show source-run + fork-node summary, textarea for the
 *      override, "Create fork" CTA.
 *   2. **Starting** — `POST /runs/replay-lab/fork` in flight.
 *   3. **Error** — surface the typed code (or transport message) with a
 *      Close button. The operator dismisses + re-opens; mid-submit isn't
 *      worth a Retry button because the textarea state is gone.
 *
 * On success the dialog calls `setRunId(result.runId)` +
 * `bumpPlatformVersion()` + `onClose()`. The run timeline in
 * `App.tsx` watches `activeRunId` so the fork run loads automatically.
 *
 * Used by `RightPanel.tsx`'s `RunsPanel` per-node fork buttons.
 */

import { useEffect, useRef, useState } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { AlertCircle, FlaskConical, GitBranch, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { tApiError } from '../i18n/server-events'
import { formatStatusLabel } from '../constants'

type SourceRun = {
  id: string
  status: string
  createdAt?: string | null
}

type Step =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'error'; message: string }

type ForkResponse = { runId: string; predecessorCount: number }

export function ReplayLabForkDialog({
  sourceRun,
  forkNodeId,
  onClose,
}: {
  sourceRun: SourceRun
  forkNodeId: string
  onClose: () => void
}) {
  const { t } = useT()
  const setRunId = useWorkflowStore((state) => state.setRunId)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [overrideText, setOverrideText] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocusTrap(dialogRef)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => { primaryRef.current?.focus() }, [step.kind])

  // ESC closes only when no async work is in flight. Starting is the
  // only async step (no polling, unlike the whole-run sibling).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (step.kind === 'starting') return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step.kind, onClose])

  const onBackdrop = () => {
    if (step.kind === 'starting') return
    onClose()
  }

  const onSubmit = async () => {
    setParseError(null)

    // Parse override client-side. Empty textarea = no override field
    // on the POST body (the route accepts that; it falls through to
    // the source run's original input value at the fork node).
    let inputOverride: unknown 
    const trimmed = overrideText.trim()
    if (trimmed.length > 0) {
      // Pre-flight the 64 KiB cap the route enforces so an over-cap
      // submit doesn't burn an AI rate-limit token. Byte-accurate via
      // TextEncoder (UTF-8), not UTF-16 code units.
      const overrideBytes = new TextEncoder().encode(trimmed).byteLength
      if (overrideBytes > 64_000) {
        setParseError(t('replayLab.fork.overrideTooLarge', { bytes: overrideBytes }))
        return
      }
      try {
        inputOverride = JSON.parse(trimmed)
      } catch {
        setParseError(t('replayLab.fork.invalidJson'))
        return
      }
      // The route's adapter seeds the fork node's stateJson with
      // { input: inputOverride }. A `null` / primitive / array override
      // would seed { input: null } etc. — almost never the operator's
      // intent and breaks this dialog's own JSDoc contract ("Empty
      // textarea = no override field"). Force a plain object so the
      // server-side shape stays consistent.
      if (
        inputOverride === null
        || typeof inputOverride !== 'object'
        || Array.isArray(inputOverride)
      ) {
        setParseError(t('replayLab.fork.overrideNotObject'))
        return
      }
    }

    setStep({ kind: 'starting' })
    try {
      const body: Record<string, unknown> = {
        sourceRunId: sourceRun.id,
        forkNodeId,
      }
      if (inputOverride !== undefined) body.inputOverride = inputOverride

      const result = await api('/runs/replay-lab/fork', {
        method: 'POST',
        body: JSON.stringify(body),
      }) as ForkResponse

      if (!aliveRef.current) return
      setRunId(result.runId)
      bumpPlatformVersion()
      onClose()
    } catch (err) {
      if (!aliveRef.current) return
      // tApiError reads ApiError.code first, falls back to message,
      // then to the localized serverEvents.fallback. The fork route
      // returns typed codes (fork_node_not_found, predecessor_not_succeeded,
      // nested_replay_lab, override_too_large, etc.) — every one has
      // an apiErrors.* catalog entry in en/es common.json.
      const message = tApiError(err) || (t('replayLab.fork.errorStart'))
      setStep({ kind: 'error', message })
    }
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdrop}>
      <div
        ref={dialogRef}
        className="run-input-dialog we-replay-lab-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-lab-fork-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <GitBranch size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">
              <FlaskConical size={12} aria-hidden="true" /> {t('replayLab.fork.sectionKicker')}
            </div>
            <h2 id="replay-lab-fork-title">{t('replayLab.fork.modalTitle', { nodeId: forkNodeId })}</h2>
            <p className="helper-text">{t('replayLab.fork.modalDescription')}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onBackdrop}
            aria-label={t('replayLab.fork.close')}
            disabled={step.kind === 'starting'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body">
          <section className="we-replay-lab-source">
            <div className="section-kicker">{t('replayLab.fork.sourceRun')}</div>
            <dl className="we-replay-lab-source-grid">
              <div>
                <dt>{t('replayLab.runId')}</dt>
                <dd className="we-replay-lab-id">{sourceRun.id}</dd>
              </div>
              <div>
                <dt>{t('replayLab.status')}</dt>
                <dd>{formatStatusLabel(sourceRun.status)}</dd>
              </div>
              <div>
                <dt>{t('replayLab.fork.forkNode')}</dt>
                <dd className="we-replay-lab-id">{forkNodeId}</dd>
              </div>
              {sourceRun.createdAt && (
                <div>
                  <dt>{t('replayLab.started')}</dt>
                  <dd>{sourceRun.createdAt}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="we-replay-lab-fork-override">
            <label htmlFor="replay-lab-fork-override" className="section-kicker">
              {t('replayLab.fork.overrideLabel')}
            </label>
            <p className="helper-text">{t('replayLab.fork.overrideHint')}</p>
            <textarea
              id="replay-lab-fork-override"
              className="code-field"
              value={overrideText}
              onChange={(event) => {
                setOverrideText(event.target.value)
                if (parseError) setParseError(null)
              }}
              disabled={step.kind === 'starting'}
              rows={6}
              spellCheck={false}
              data-testid="replay-lab-fork-override"
              aria-invalid={parseError ? true : undefined}
              aria-describedby={parseError ? 'replay-lab-fork-override-error' : undefined}
            />
            {parseError && (
              <div id="replay-lab-fork-override-error" className="run-input-form-error" role="alert">
                <AlertCircle size={14} aria-hidden="true" />
                <div>{parseError}</div>
              </div>
            )}
          </section>

          {step.kind === 'error' && (
            <div className="run-input-form-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <div>{step.message}</div>
            </div>
          )}
        </div>

        <footer className="run-input-dialog__footer">
          {step.kind === 'idle' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                {t('replayLab.fork.cancel')}
              </button>
              <button
                ref={primaryRef}
                type="button"
                className="command-button command-button-primary"
                onClick={onSubmit}
                data-testid="replay-lab-fork-submit"
              >
                <GitBranch size={14} aria-hidden="true" />
                {t('replayLab.fork.submit')}
              </button>
            </>
          )}
          {step.kind === 'starting' && (
            <button type="button" className="command-button command-button-primary" disabled>
              {t('replayLab.fork.starting')}
            </button>
          )}
          {step.kind === 'error' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                {t('replayLab.fork.close')}
              </button>
              <button
                ref={primaryRef}
                type="button"
                className="command-button command-button-primary"
                onClick={() => setStep({ kind: 'idle' })}
                data-testid="replay-lab-fork-back"
              >
                {t('common.back')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
