/**
 * Failure-recovery dialog. Walks an operator through a 3-step flow:
 *
 *   1. **Idle** — explain what's about to happen, expose a "Generate
 *      suggestion" button.
 *   2. **Loading** — `POST /ai/patch-workflow` is in flight.
 *   3. **Review** — render the AI-suggested workflow as a diff against
 *      the failing version (via `WorkflowDiffView` from the version-diff
 *      ticket) and surface the LLM rationale alongside.
 *   4. **Applying** — `POST /workflows/save` followed by `POST
 *      /dlq/replay` chained together.
 *   5. **Applied** — success ribbon + replay run id.
 *   6. **Error** — surfaces the failure with a Retry button that
 *      re-enters Idle.
 *
 * Reuses the `run-input-*` modal CSS tokens from the run-input dialog
 * (same-shape modal). The Apply button is disabled when the suggestion
 * came back as `mode: "fallback"` (no point applying a no-op).
 *
 * Used by `DeadLettersPanel.tsx` — a Suggest-fix button per row mounts
 * this dialog with the selected DLQ row.
 */

import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Play, Sparkles, X } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { WorkflowDiffView } from './WorkflowDiffView'
import type { DeadLetter } from './DeadLettersPanel'

type PatchSuggestion = {
  mode: 'ai' | 'fallback'
  suggestedWorkflow: WorkflowDefinition
  rationale: string
  model?: string
  provider?: string
  aiError?: string
}

type Step =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'review'; suggestion: PatchSuggestion }
  | { kind: 'applying' }
  | { kind: 'applied'; runId?: string }
  | { kind: 'error'; message: string }

type RecoveryDialogProps = {
  dlq: DeadLetter
  onClose: () => void
}

const DESCRIPTION =
  'Janusly will analyse the failure and propose a workflow change. Review the diff before anything is saved.'

export function RecoveryDialog({ dlq, onClose }: RecoveryDialogProps) {
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const primaryRef = useRef<HTMLButtonElement | null>(null)

  // Focus the primary action on mount so keyboard users can hit Enter.
  useEffect(() => { primaryRef.current?.focus() }, [])

  // ESC closes — but only when no async work is in flight, otherwise
  // the operator could lose an in-progress save.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (step.kind === 'loading' || step.kind === 'applying') return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, step.kind])

  const generateSuggestion = async () => {
    setStep({ kind: 'loading' })
    try {
      const result = await api('/ai/patch-workflow', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId: dlq.id }),
      }) as PatchSuggestion
      setStep({ kind: 'review', suggestion: result })
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Suggestion request failed',
      })
    }
  }

  const applyPatch = async () => {
    if (step.kind !== 'review') return
    setStep({ kind: 'applying' })
    try {
      await api('/workflows/save', {
        method: 'POST',
        body: JSON.stringify(step.suggestion.suggestedWorkflow),
      })
      // Save is durable. Bump now so sibling panels (Workflows list,
      // Version history, Health badge) refetch even when the downstream
      // replay throws — without this, a save+replay sequence that fails
      // at replay leaves panels stale until a manual refresh.
      bumpPlatformVersion()
      const replay = await api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId: dlq.id }),
      }) as { runId?: string }
      setStep({ kind: 'applied', runId: replay.runId })
      bumpPlatformVersion()
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Apply failed',
      })
    }
  }

  const onBackdropClick = () => {
    if (step.kind === 'loading' || step.kind === 'applying') return
    onClose()
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdropClick}>
      <div
        className="run-input-dialog we-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">Suggest a fix</div>
            <h2 id="recovery-dialog-title">{describeDeadLetter(dlq)}</h2>
            <p className="helper-text">{DESCRIPTION}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label="Close recovery dialog"
            disabled={step.kind === 'loading' || step.kind === 'applying'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body">
          {step.kind === 'idle' && (
            <p className="helper-text">
              The failing node is <code>{dlq.nodeId}</code> on run <code>{dlq.runId.slice(0, 8)}…</code> after
              {' '}{dlq.attempt} attempt{dlq.attempt === 1 ? '' : 's'}. Click <strong>Generate suggestion</strong> to ask
              Janusly for a patch.
            </p>
          )}

          {step.kind === 'loading' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              Analyzing run history…
            </p>
          )}

          {step.kind === 'review' && (
            <ReviewBody suggestion={step.suggestion} dlq={dlq} />
          )}

          {step.kind === 'applying' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              Saving the new workflow version and replaying the failed entry…
            </p>
          )}

          {step.kind === 'applied' && (
            <div className="we-recovery-success" role="alert">
              <CheckCircle2 size={14} aria-hidden="true" />
              <div>
                <strong>Patch applied.</strong>
                {step.runId
                  ? ` Replay started — run id ${step.runId.slice(0, 8)}…`
                  : ' DLQ entry replayed.'}
              </div>
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
          {step.kind === 'idle' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="command-button command-button-primary"
                onClick={generateSuggestion}
              >
                <Sparkles size={14} aria-hidden="true" />
                <span>Generate suggestion</span>
              </button>
            </>
          )}

          {step.kind === 'review' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="command-button command-button-primary"
                onClick={applyPatch}
                disabled={step.suggestion.mode === 'fallback'}
              >
                <Play size={14} aria-hidden="true" />
                <span>Apply &amp; replay</span>
              </button>
            </>
          )}

          {step.kind === 'error' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="command-button command-button-primary"
                onClick={() => setStep({ kind: 'idle' })}
              >
                Retry
              </button>
            </>
          )}

          {step.kind === 'applied' && (
            <button
              type="button"
              ref={primaryRef}
              className="command-button command-button-primary"
              onClick={onClose}
            >
              Close
            </button>
          )}

          {(step.kind === 'loading' || step.kind === 'applying') && (
            <button type="button" className="command-button" disabled>
              Working…
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function ReviewBody({ suggestion, dlq }: { suggestion: PatchSuggestion; dlq: DeadLetter }) {
  return (
    <>
      {suggestion.mode === 'fallback' && (
        <div className="we-recovery-warning" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <div>
            <strong>AI was unavailable.</strong> The original workflow is shown below — Apply is disabled because there's
            nothing to change.
            {suggestion.aiError ? ` Reason: ${suggestion.aiError}` : null}
          </div>
        </div>
      )}
      <WorkflowDiffView
        before={(dlq.workflowJson ?? {}) as WorkflowDefinition}
        after={suggestion.suggestedWorkflow}
        beforeLabel="Current"
        afterLabel="Suggested"
        aiPatchRationale={suggestion.rationale}
      />
    </>
  )
}

function describeDeadLetter(dlq: DeadLetter): string {
  return `Recover ${dlq.nodeId} on run ${dlq.runId.slice(0, 8)}…`
}
