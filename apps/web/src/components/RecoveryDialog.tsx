/**
 * Failure-recovery dialog. Walks an operator through a sandbox-validated
 * apply flow:
 *
 *   1. **Idle** — explain what's about to happen, expose a "Generate
 *      suggestion" button.
 *   2. **Loading** — `POST /ai/patch-workflow` is in flight.
 *   3. **Review** — render the AI-suggested workflow as a diff against
 *      the failing version (via `WorkflowDiffView`) and surface the LLM
 *      rationale alongside.
 *   4. **Validating** — `POST /dlq/validate-fix` returns a sandbox
 *      run id; the dialog polls `GET /run?runId=…` until terminal.
 *      Validation runs are tagged `replayMode: "validation"` and don't
 *      write a `workflow_versions` row.
 *   5. **Validation-failed** — the sandbox run reached `failed` /
 *      `cancelled`; surfaces the failed node's `errorJson` plus an
 *      "Iterate" button that re-opens the suggestion flow.
 *   6. **Applying** — sandbox passed; `POST /workflows/save` followed
 *      by `POST /dlq/replay` (the production replay) chained together.
 *   7. **Applied** — success ribbon + production replay run id.
 *   8. **Error** — surfaces a transport / unexpected failure with a
 *      Retry button that re-enters Idle.
 *
 * Reuses the `run-input-*` modal CSS tokens from the run-input dialog
 * (same-shape modal). The Apply button is disabled when the suggestion
 * came back as `mode: "fallback"` (no point applying a no-op).
 *
 * Used by `DeadLettersPanel.tsx` — a Suggest-fix button per row mounts
 * this dialog with the selected DLQ row.
 */

import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Play, RefreshCcw, Sparkles, X } from 'lucide-react'
import { computeWorkflowDiff } from '@janusly/shared/src/workflow-diff'
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
  | { kind: 'validating'; suggestion: PatchSuggestion; runId: string }
  | { kind: 'validation-failed'; suggestion: PatchSuggestion; runId: string; errorJson: unknown }
  | { kind: 'applying' }
  | { kind: 'applied'; runId?: string }
  | { kind: 'error'; message: string }

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const VALIDATION_POLL_INTERVAL_MS = 1500

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
  const canApplyPatch = step.kind === 'review'
    ? isActionableSuggestion(dlq.workflowJson, step.suggestion)
    : false

  // Focus the primary action on mount so keyboard users can hit Enter.
  useEffect(() => { primaryRef.current?.focus() }, [])

  // ESC closes — but only when no async work is in flight, otherwise
  // the operator could lose an in-progress save.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (step.kind === 'loading' || step.kind === 'applying' || step.kind === 'validating') return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, step.kind])

  // Poll the validation run until it reaches a terminal status. The poll
  // tears itself down when the dialog closes or the step transitions
  // away from `validating`, so a long-running validation can't leak
  // requests after the operator dismisses the dialog.
  useEffect(() => {
    if (step.kind !== 'validating') return
    let cancelled = false
    const poll = async () => {
      try {
        const result = await api(`/run?runId=${encodeURIComponent(step.runId)}`) as RunStatusPayload
        if (cancelled) return
        const status = result.run?.status
        if (!status || !TERMINAL_STATUSES.has(status)) {
          return
        }
        // Claim the terminal-status path BEFORE yielding to async work
        // (or to React's render). Concurrent in-flight polls share this
        // closure's `cancelled` flag — flipping it here means a poll
        // that resolved a tick later sees `cancelled = true` after its
        // own `await api(...)` returns and bails. Without this, a slow
        // `/run` endpoint that returns `succeeded` on two overlapping
        // polls would call `applyAfterValidation` twice (and therefore
        // double-save and double-replay).
        cancelled = true
        if (status === 'succeeded') {
          await applyAfterValidation(step.suggestion)
          return
        }
        const errorJson = pickFailedNodeErrorJson(result.nodes ?? [], dlq.nodeId)
        setStep({
          kind: 'validation-failed',
          suggestion: step.suggestion,
          runId: step.runId,
          errorJson,
        })
      } catch (error) {
        if (cancelled) return
        setStep({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Validation polling failed',
        })
      }
    }
    poll()
    const handle = window.setInterval(poll, VALIDATION_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
    // applyAfterValidation closes over `bumpPlatformVersion` and `dlq.id`
    // which don't change between renders; intentionally exclude from deps
    // so the poll restarts only on a real step transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind, step.kind === 'validating' ? step.runId : null])

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

  const validateAndApply = async () => {
    if (step.kind !== 'review') return
    const suggestion = step.suggestion
    try {
      const result = await api('/dlq/validate-fix', {
        method: 'POST',
        body: JSON.stringify({
          deadLetterId: dlq.id,
          suggestedWorkflow: suggestion.suggestedWorkflow,
        }),
      }) as { runId: string }
      setStep({ kind: 'validating', suggestion, runId: result.runId })
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Validation request failed',
      })
    }
  }

  const applyAfterValidation = async (suggestion: PatchSuggestion) => {
    setStep({ kind: 'applying' })
    try {
      await api('/workflows/save', {
        method: 'POST',
        body: JSON.stringify(suggestion.suggestedWorkflow),
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
    if (step.kind === 'loading' || step.kind === 'applying' || step.kind === 'validating') return
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
            disabled={step.kind === 'loading' || step.kind === 'applying' || step.kind === 'validating'}
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
            <ReviewBody suggestion={step.suggestion} dlq={dlq} canApplyPatch={canApplyPatch} />
          )}

          {step.kind === 'validating' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              Validating fix in a sandbox run — write-side actions are skipped, terminal status will gate Apply…
            </p>
          )}

          {step.kind === 'validation-failed' && (
            <ValidationFailedBody
              suggestion={step.suggestion}
              dlq={dlq}
              runId={step.runId}
              errorJson={step.errorJson}
            />
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
                onClick={validateAndApply}
                disabled={!canApplyPatch}
              >
                <Play size={14} aria-hidden="true" />
                <span>Apply &amp; validate</span>
              </button>
            </>
          )}

          {step.kind === 'validation-failed' && (
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
                <RefreshCcw size={14} aria-hidden="true" />
                <span>Iterate</span>
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

          {(step.kind === 'loading' || step.kind === 'applying' || step.kind === 'validating') && (
            <button type="button" className="command-button" disabled>
              Working…
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function ReviewBody({
  suggestion,
  dlq,
  canApplyPatch,
}: {
  suggestion: PatchSuggestion
  dlq: DeadLetter
  canApplyPatch: boolean
}) {
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
      {suggestion.mode === 'ai' && !canApplyPatch && (
        <div className="we-recovery-warning" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <div>
            <strong>No structural patch was returned.</strong> Review the rationale and make the Inspector change manually
            before replaying.
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

function ValidationFailedBody({
  suggestion,
  dlq,
  runId,
  errorJson,
}: {
  suggestion: PatchSuggestion
  dlq: DeadLetter
  runId: string
  errorJson: unknown
}) {
  const message = pickErrorMessage(errorJson)
  return (
    <>
      <div className="we-recovery-warning" role="alert">
        <AlertCircle size={14} aria-hidden="true" />
        <div>
          <strong>Sandbox replay failed.</strong> The suggested patch did not pass validation against the failing entry —
          nothing has been saved. Review the error below and click <strong>Iterate</strong> to ask Janusly for a different
          fix. Validation run id <code>{runId.slice(0, 8)}…</code>.
        </div>
      </div>
      {message ? (
        <pre className="we-recovery-error-detail" aria-label="Validation error detail">
          {message}
        </pre>
      ) : null}
      <WorkflowDiffView
        before={(dlq.workflowJson ?? {}) as WorkflowDefinition}
        after={suggestion.suggestedWorkflow}
        beforeLabel="Current"
        afterLabel="Suggested (rejected)"
        aiPatchRationale={suggestion.rationale}
      />
    </>
  )
}

function describeDeadLetter(dlq: DeadLetter): string {
  return `Recover ${dlq.nodeId} on run ${dlq.runId.slice(0, 8)}…`
}

type RunStatusPayload = {
  run?: { status?: string }
  nodes?: Array<{ nodeId?: string; status?: string; errorJson?: unknown }>
}

function pickFailedNodeErrorJson(nodes: RunStatusPayload['nodes'], failingNodeId: string): unknown {
  if (!nodes) return null
  // Prefer the originally-failing node's error so the operator sees the
  // reason their proposed fix didn't unstick the run; fall back to any
  // failed node's error if some downstream step blew up instead.
  const focus = nodes.find((n) => n.nodeId === failingNodeId && n.status === 'failed')
  if (focus?.errorJson) return focus.errorJson
  const anyFailed = nodes.find((n) => n.status === 'failed')
  return anyFailed?.errorJson ?? null
}

function pickErrorMessage(errorJson: unknown): string | null {
  if (!errorJson || typeof errorJson !== 'object') return null
  const candidate = (errorJson as { message?: unknown }).message
  if (typeof candidate === 'string' && candidate.length > 0) return candidate
  try {
    return JSON.stringify(errorJson, null, 2)
  } catch {
    return null
  }
}

function isActionableSuggestion(currentWorkflow: unknown, suggestion: PatchSuggestion): boolean {
  if (suggestion.mode !== 'ai') return false
  const diff = computeWorkflowDiff(toWorkflow(currentWorkflow), toWorkflow(suggestion.suggestedWorkflow))
  return diff.summary.totalChanges > 0
}

function toWorkflow(value: unknown): WorkflowDefinition {
  if (value && typeof value === 'object') return value as WorkflowDefinition
  return { dslVersion: '1.0', nodes: [], edges: [] }
}
