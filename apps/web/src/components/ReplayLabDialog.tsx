/**
 * Replay Lab dialog — opens a sandbox replay against an existing run.
 * State machine:
 *
 *   1. **Idle** — show source-run summary + "Start replay" CTA.
 *   2. **Starting** — `POST /runs/replay-lab` in flight.
 *   3. **Replaying** — got the new validation run id; poll
 *      `GET /run?runId=…` at 1500ms until terminal.
 *   4. **Comparing** — pulling `GET /runs/compare` for the per-node
 *      breakdown.
 *   5. **Done** — render `<RunComparisonView />` plus a Close button.
 *   6. **Error** — surface a transport / unexpected failure with Retry.
 *
 * The sandbox tag (`runs.replayMode = "validation"`) flows from the
 * engine adapter, so the same dryRun gates and rollup exclusions the
 * Recovery dialog already relies on apply uniformly.
 *
 * Used by `RightPanel.tsx` (active-run + run-history entry buttons)
 * and `DeadLettersPanel.tsx` (selected-entry action bar).
 */

import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, FlaskConical, Play, RefreshCcw, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { RunComparisonView, type RunComparisonPayload } from './RunComparisonView'

type SourceRun = {
  id: string
  status: string
  workflowVersionId?: string
  createdAt?: string | null
}

type Step =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'replaying'; replayRunId: string; replayStatus: string }
  | { kind: 'comparing'; replayRunId: string; replayStatus: string }
  | { kind: 'done'; replayRunId: string; replayStatus: string; comparison: RunComparisonPayload }
  | { kind: 'error'; message: string }

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])
const POLL_INTERVAL_MS = 1500

type RunStatusPayload = {
  run?: { status?: string }
  nodes?: unknown
  events?: unknown
}

export function ReplayLabDialog({
  sourceRun,
  onClose,
}: {
  sourceRun: SourceRun
  onClose: () => void
}) {
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => { primaryRef.current?.focus() }, [step.kind])

  // ESC closes only when no async work is in flight. Polling counts as
  // in flight — abandoning a poll silently is fine (the run still
  // completes in the background), but blocking ESC keeps the operator
  // from accidentally tossing the lab they just started.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (
        step.kind === 'starting'
        || step.kind === 'replaying'
        || step.kind === 'comparing'
      ) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step.kind, onClose])

  // Stable primitives derived from the prop + step. The polling effect
  // depends on these directly so the dep array is plain values (no
  // inline ternary, which `eslint-plugin-react-hooks` flags as
  // non-stable). `replayingRunId` is `null` for every non-replaying
  // step, which keeps the effect inert.
  const sourceRunId = sourceRun.id
  const replayingRunId = step.kind === 'replaying' ? step.replayRunId : null

  // Poll the replay run until terminal, then transition into the
  // comparison-fetch step. Mirror the RecoveryDialog cleanup pattern
  // so an unmount mid-poll doesn't leak the interval.
  useEffect(() => {
    if (!replayingRunId) return
    let cancelled = false

    const tick = async () => {
      try {
        const result = await api(`/run?runId=${encodeURIComponent(replayingRunId)}`) as RunStatusPayload
        if (cancelled || !aliveRef.current) return
        const status = result.run?.status
        if (!status) return
        if (!TERMINAL_STATUSES.has(status)) {
          // Update the visible status so the operator sees "running →
          // succeeded" without waiting for the terminal flip.
          setStep((prev) => prev.kind === 'replaying'
            ? { ...prev, replayStatus: status }
            : prev,
          )
          return
        }
        cancelled = true
        bumpPlatformVersion()
        setStep({ kind: 'comparing', replayRunId: replayingRunId, replayStatus: status })
        try {
          const comparison = await api(
            `/runs/compare?baseRunId=${encodeURIComponent(sourceRunId)}&replayRunId=${encodeURIComponent(replayingRunId)}`,
          ) as RunComparisonPayload
          if (!aliveRef.current) return
          setStep({ kind: 'done', replayRunId: replayingRunId, replayStatus: status, comparison })
        } catch (err) {
          if (!aliveRef.current) return
          setStep({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Failed to load comparison',
          })
        }
      } catch (err) {
        if (cancelled || !aliveRef.current) return
        setStep({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Polling the replay run failed',
        })
      }
    }

    tick()
    const handle = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [replayingRunId, sourceRunId, bumpPlatformVersion])

  const startReplay = async () => {
    setStep({ kind: 'starting' })
    try {
      const result = await api('/runs/replay-lab', {
        method: 'POST',
        body: JSON.stringify({ sourceRunId: sourceRun.id }),
      }) as { runId: string }
      if (!aliveRef.current) return
      setStep({ kind: 'replaying', replayRunId: result.runId, replayStatus: 'running' })
    } catch (err) {
      if (!aliveRef.current) return
      setStep({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to start replay',
      })
    }
  }

  const onBackdrop = () => {
    if (
      step.kind === 'starting'
      || step.kind === 'replaying'
      || step.kind === 'comparing'
    ) return
    onClose()
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdrop}>
      <div
        className="run-input-dialog we-replay-lab-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-lab-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <FlaskConical size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">Replay Lab</div>
            <h2 id="replay-lab-title">Sandbox replay</h2>
            <p className="helper-text">
              Re-run this run in a sandbox. Write-side HTTP calls and tools flagged write-side
              are skipped. The result won&apos;t affect production metrics or be saved as a new
              version.
            </p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onBackdrop}
            aria-label="Close Replay Lab"
            disabled={step.kind === 'starting' || step.kind === 'replaying' || step.kind === 'comparing'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body">
          <section className="we-replay-lab-source">
            <div className="section-kicker">Source run</div>
            <dl className="we-replay-lab-source-grid">
              <div>
                <dt>Run id</dt>
                <dd className="we-replay-lab-id">{sourceRun.id}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{sourceRun.status}</dd>
              </div>
              {sourceRun.createdAt && (
                <div>
                  <dt>Started</dt>
                  <dd>{sourceRun.createdAt}</dd>
                </div>
              )}
            </dl>
          </section>

          {step.kind === 'error' && (
            <div className="run-input-form-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <div>{step.message}</div>
            </div>
          )}

          {(step.kind === 'replaying' || step.kind === 'comparing') && (
            <section className="we-replay-lab-progress" aria-live="polite">
              <div className="section-kicker">Replay run</div>
              <p className="helper-text">
                Sandbox run <code className="we-replay-lab-id">{step.replayRunId}</code> is{' '}
                <strong>{step.replayStatus}</strong>
                {step.kind === 'comparing' ? ' — loading comparison…' : '…'}
              </p>
            </section>
          )}

          {step.kind === 'done' && (
            <section className="we-replay-lab-result">
              <div className="section-kicker">Comparison</div>
              <RunComparisonView payload={step.comparison} />
            </section>
          )}
        </div>

        <footer className="run-input-dialog__footer">
          {step.kind === 'idle' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                Cancel
              </button>
              <button
                ref={primaryRef}
                type="button"
                className="command-button command-button-primary"
                onClick={startReplay}
                data-testid="replay-lab-start"
              >
                <Play size={14} aria-hidden="true" />
                Start replay
              </button>
            </>
          )}
          {step.kind === 'starting' && (
            <button type="button" className="command-button command-button-primary" disabled>
              Starting…
            </button>
          )}
          {(step.kind === 'replaying' || step.kind === 'comparing') && (
            <button type="button" className="command-button command-button-primary" disabled>
              Running…
            </button>
          )}
          {step.kind === 'done' && (
            <button
              ref={primaryRef}
              type="button"
              className="command-button command-button-primary"
              onClick={onClose}
              data-testid="replay-lab-close-done"
            >
              Close
            </button>
          )}
          {step.kind === 'error' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                Close
              </button>
              <button
                ref={primaryRef}
                type="button"
                className="command-button command-button-primary"
                onClick={() => setStep({ kind: 'idle' })}
              >
                <RefreshCcw size={14} aria-hidden="true" />
                Retry
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
