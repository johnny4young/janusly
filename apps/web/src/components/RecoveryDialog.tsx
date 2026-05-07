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

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Play, RefreshCcw, Sparkles, X } from 'lucide-react'
import { computeWorkflowDiff } from '@janusly/shared/src/workflow-diff'
import { normalizeErrorSignature } from '@janusly/shared/src/error-signature'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { WorkflowDiffView } from './WorkflowDiffView'
import { RecoveryDeltaCard, type PreSaveBeforeSnapshot } from './RecoveryDeltaCard'
import type { DeadLetter } from './DeadLettersPanel'

type PatchApproachLabel =
  | 'add_retry'
  | 'raise_timeout'
  | 'swap_secret_ref'
  | 'add_approval'
  | 'fix_url'
  | 'other'

type SuggestionTab = {
  workflow: WorkflowDefinition
  rationale: string
  approachLabel: PatchApproachLabel
  confidence: number
}

type PatchSuggestion = {
  mode: 'ai' | 'fallback'
  /** Legacy mirror of `suggestions[0]` — kept so older test fixtures and callers still work. */
  suggestedWorkflow: WorkflowDefinition
  /** Legacy mirror of `suggestions[0].rationale`. */
  rationale: string
  /** 1-3 alternative patches sorted by confidence desc. The route guarantees length ≥ 1. */
  suggestions: SuggestionTab[]
  model?: string
  provider?: string
  aiError?: string
}

const APPROACH_LABEL_DISPLAY: Record<PatchApproachLabel, string> = {
  add_retry: 'Add retry',
  raise_timeout: 'Raise timeout',
  swap_secret_ref: 'Swap secret',
  add_approval: 'Add approval',
  fix_url: 'Fix URL',
  other: 'Other',
}

type ClusterApplyError = {
  deadLetterId: string
  error: string
}

type ClusterApplyResult = {
  replayed: number
  failed: number
  errors: ClusterApplyError[]
}

type Step =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'review'; suggestion: PatchSuggestion }
  | { kind: 'validating'; suggestion: PatchSuggestion; selectedIndex: number; runId: string }
  | { kind: 'validation-failed'; suggestion: PatchSuggestion; selectedIndex: number; runId: string; errorJson: unknown }
  | { kind: 'applying'; mode: 'single' | 'cluster'; total?: number }
  | {
      kind: 'applied'
      runId?: string
      cluster?: ClusterApplyResult
      // Threaded through to <RecoveryDeltaCard>. All optional so save-route
      // responses without a parseable shape (defensive — the route's
      // contract guarantees these) fall back to the legacy ribbon.
      appliedWorkflowId?: string
      appliedVersion?: number
      priorFailureSignature?: string | null
      preSaveBeforeSnapshot?: PreSaveBeforeSnapshot | null
    }
  | { kind: 'error'; message: string }

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const VALIDATION_POLL_INTERVAL_MS = 1500

type RecoveryDialogProps = {
  dlq: DeadLetter
  onClose: () => void
  /**
   * Cluster-mode props. When `clusterMembers` is set, the dialog applies
   * the saved patch to every listed DLQ id via `POST /dlq/cluster-apply`
   * instead of replaying just `dlq.id`. Validation still runs once on
   * the representative `dlq` so the sandbox cost stays bounded.
   * `clusterSignature` is required when `clusterMembers` is set — it
   * goes into the audit metadata and the server-side signature gate.
   */
  clusterMembers?: string[]
  clusterSignature?: string
  clusterMembersCapped?: boolean
  clusterMembersTotal?: number
}

const DESCRIPTION =
  'Janusly will analyse the failure and propose a workflow change. Review the diff before anything is saved.'

export function RecoveryDialog({
  dlq,
  onClose,
  clusterMembers,
  clusterSignature,
  clusterMembersCapped,
  clusterMembersTotal,
}: RecoveryDialogProps) {
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const [step, setStep] = useState<Step>({ kind: 'idle' })

  // Derive the original failure's signature once when the source DLQ
  // mounts. The delta route uses this to count "same failure since
  // Apply" — if the operator's fix worked, that count stays at 0.
  // Defense-in-depth: the helper scrubs token-shaped substrings before
  // returning, so the signature surfaced through the URL is safe.
  const priorFailureSignature = useMemo(() => {
    const errorJson = dlq.errorJson
    const nodeJson = dlq.nodeJson as { type?: string } | null
    return normalizeErrorSignature(errorJson, {
      nodeId: dlq.nodeId,
      nodeType: nodeJson?.type,
    }).signature
  }, [dlq.errorJson, dlq.nodeId, dlq.nodeJson])
  // Which suggestion the operator picked from the tab strip. Reset to 0
  // every time a new review step starts so a fresh "Generate suggestion"
  // call doesn't carry over a stale tab from a prior run.
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)
  const isClusterMode = Array.isArray(clusterMembers) && clusterMembers.length > 0 && typeof clusterSignature === 'string'
  const clusterMemberCount = clusterMembers?.length ?? 0
  const clusterVisibleTotal = clusterMembersTotal && clusterMembersTotal > clusterMemberCount
    ? clusterMembersTotal
    : clusterMemberCount
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const reviewSuggestions = step.kind === 'review' ? step.suggestion.suggestions : []
  const safeSelectedIndex = Math.min(selectedSuggestionIndex, Math.max(reviewSuggestions.length - 1, 0))
  const selectedSuggestion: SuggestionTab | null = step.kind === 'review'
    ? (reviewSuggestions[safeSelectedIndex] ?? null)
    : null
  const canApplyPatch = step.kind === 'review' && selectedSuggestion
    ? isActionableSuggestion(dlq.workflowJson, step.suggestion, selectedSuggestion)
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
          await applyAfterValidation(step.suggestion, step.selectedIndex)
          return
        }
        const errorJson = pickFailedNodeErrorJson(result.nodes ?? [], dlq.nodeId)
        setStep({
          kind: 'validation-failed',
          suggestion: step.suggestion,
          selectedIndex: step.selectedIndex,
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
      const normalised = normalisePatchSuggestion(result)
      setSelectedSuggestionIndex(0)
      setStep({ kind: 'review', suggestion: normalised })
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
    const selected = suggestion.suggestions[safeSelectedIndex]
    if (!selected) return
    try {
      const result = await api('/dlq/validate-fix', {
        method: 'POST',
        body: JSON.stringify({
          deadLetterId: dlq.id,
          suggestedWorkflow: selected.workflow,
        }),
      }) as { runId: string }
      setStep({ kind: 'validating', suggestion, selectedIndex: safeSelectedIndex, runId: result.runId })
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Validation request failed',
      })
    }
  }

  const applyAfterValidation = async (suggestion: PatchSuggestion, selectedIndex: number) => {
    const selected = suggestion.suggestions[selectedIndex]
    if (!selected) {
      setStep({ kind: 'error', message: 'Selected suggestion is no longer available.' })
      return
    }
    const mode: 'single' | 'cluster' = isClusterMode ? 'cluster' : 'single'
    const total = isClusterMode ? clusterMembers!.length : undefined
    setStep({ kind: 'applying', mode, total })

    // Capture the pre-save snapshot of the workflow's current health so
    // the delta card can render the "before" pills statically without a
    // loading flash. Non-blocking: when this fails the card falls back
    // to fetching everything via /workflows/health/delta.
    const targetWorkflowId = selected.workflow.id ?? null
    let preSaveBeforeSnapshot: PreSaveBeforeSnapshot | null = null
    if (targetWorkflowId) {
      try {
        const snapshot = await api(`/workflows/health?workflowId=${encodeURIComponent(targetWorkflowId)}`) as {
          score?: number
          status?: string
          signals?: { p95LatencyMs?: number | null; totalRuns?: number; totalCostUsd?: number }
        }
        if (typeof snapshot.score === 'number' && typeof snapshot.status === 'string' && snapshot.signals) {
          preSaveBeforeSnapshot = {
            score: snapshot.score,
            status: snapshot.status,
            signals: {
              p95LatencyMs: snapshot.signals.p95LatencyMs ?? null,
              totalRuns: snapshot.signals.totalRuns ?? 0,
              totalCostUsd: snapshot.signals.totalCostUsd ?? 0,
            },
          }
        }
      } catch {
        // Ignore — card fetches before-side on its own as a fallback.
      }
    }

    try {
      const saveResponse = await api('/workflows/save', {
        method: 'POST',
        body: JSON.stringify(selected.workflow),
      }) as { workflowId?: string; versionId?: string; version?: number }
      const appliedWorkflowId = typeof saveResponse.workflowId === 'string' ? saveResponse.workflowId : undefined
      const appliedVersion = typeof saveResponse.version === 'number' ? saveResponse.version : undefined

      // Save is durable. Bump now so sibling panels (Workflows list,
      // Version history, Health badge) refetch even when the downstream
      // replay throws — without this, a save+replay sequence that fails
      // at replay leaves panels stale until a manual refresh.
      bumpPlatformVersion()
      if (isClusterMode) {
        // Bulk replay — one save above + N replays in series. The route
        // re-validates each row's signature server-side so a stale
        // member list (rows replayed via another path between fetch and
        // apply) is rejected per-row instead of corrupting the batch.
        const result = await api('/dlq/cluster-apply', {
          method: 'POST',
          body: JSON.stringify({
            clusterSignature,
            deadLetterIds: clusterMembers,
          }),
        }) as ClusterApplyResult
        setStep({
          kind: 'applied',
          cluster: result,
          appliedWorkflowId,
          appliedVersion,
          priorFailureSignature,
          preSaveBeforeSnapshot,
        })
        bumpPlatformVersion()
        return
      }
      const replay = await api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId: dlq.id }),
      }) as { runId?: string }
      setStep({
        kind: 'applied',
        runId: replay.runId,
        appliedWorkflowId,
        appliedVersion,
        priorFailureSignature,
        preSaveBeforeSnapshot,
      })
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
              {' '}{dlq.attempt} attempt{dlq.attempt === 1 ? '' : 's'}.
              {isClusterMode ? (
                <>
                  {' '}This pattern matches <strong>{clusterMemberCount}{clusterMembersCapped ? ` of ${clusterVisibleTotal}` : ''}</strong> open DLQ entries —
                  approving the patch will replay {clusterMembersCapped ? 'this capped batch' : 'all of them'} after the sandbox check.
                </>
              ) : null}
              {' '}Click <strong>Generate suggestion</strong> to ask Janusly for a patch.
            </p>
          )}

          {step.kind === 'loading' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              Analyzing run history…
            </p>
          )}

          {step.kind === 'review' && selectedSuggestion && (
            <ReviewBody
              suggestion={step.suggestion}
              selected={selectedSuggestion}
              selectedIndex={safeSelectedIndex}
              onSelectIndex={setSelectedSuggestionIndex}
              dlq={dlq}
              canApplyPatch={canApplyPatch}
            />
          )}

          {step.kind === 'validating' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              Validating fix in a sandbox run — write-side actions are skipped, terminal status will gate Apply…
            </p>
          )}

          {step.kind === 'validation-failed' && (
            <ValidationFailedBody
              suggestion={step.suggestion}
              selectedIndex={step.selectedIndex}
              dlq={dlq}
              runId={step.runId}
              errorJson={step.errorJson}
            />
          )}

          {step.kind === 'applying' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              {step.mode === 'cluster' && step.total
                ? `Saving the new workflow version and replaying ${step.total} matching DLQ entries…`
                : 'Saving the new workflow version and replaying the failed entry…'}
            </p>
          )}

          {step.kind === 'applied' && (
            <AppliedBody
              runId={step.runId}
              cluster={step.cluster}
              appliedWorkflowId={step.appliedWorkflowId}
              appliedVersion={step.appliedVersion}
              priorFailureSignature={step.priorFailureSignature ?? null}
              preSaveBeforeSnapshot={step.preSaveBeforeSnapshot ?? null}
            />
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
                <span>
                  {isClusterMode
                    ? `Apply & validate (${clusterMembers!.length} entries)`
                    : 'Apply & validate'}
                </span>
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
  selected,
  selectedIndex,
  onSelectIndex,
  dlq,
  canApplyPatch,
}: {
  suggestion: PatchSuggestion
  selected: SuggestionTab
  selectedIndex: number
  onSelectIndex: (index: number) => void
  dlq: DeadLetter
  canApplyPatch: boolean
}) {
  const tabs = suggestion.suggestions
  const showTabs = tabs.length > 1
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!showTabs) return
    const lastIndex = tabs.length - 1
    const nextIndexByKey: Record<string, number> = {
      ArrowRight: index === lastIndex ? 0 : index + 1,
      ArrowDown: index === lastIndex ? 0 : index + 1,
      ArrowLeft: index === 0 ? lastIndex : index - 1,
      ArrowUp: index === 0 ? lastIndex : index - 1,
      Home: 0,
      End: lastIndex,
    }
    const nextIndex = nextIndexByKey[event.key]
    if (nextIndex === undefined) return
    event.preventDefault()
    onSelectIndex(nextIndex)
    window.requestAnimationFrame(() => {
      document.getElementById(`we-recovery-tab-${nextIndex}`)?.focus()
    })
  }
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
      {showTabs && (
        <div className="we-recovery-tabs" role="tablist" aria-label="Alternative suggestions">
          {tabs.map((tab, index) => (
            <button
              key={index}
              type="button"
              role="tab"
              id={`we-recovery-tab-${index}`}
              aria-controls="we-recovery-tabpanel"
              aria-selected={index === selectedIndex}
              tabIndex={index === selectedIndex ? 0 : -1}
              className={`we-recovery-tab${index === selectedIndex ? ' we-recovery-tab--active' : ''}`}
              onClick={() => onSelectIndex(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              title={`Self-rated confidence: ${tab.confidence}%`}
            >
              <span className="we-recovery-tab__label">{APPROACH_LABEL_DISPLAY[tab.approachLabel] ?? tab.approachLabel}</span>
              <span className="we-recovery-tab__confidence">{tab.confidence}%</span>
            </button>
          ))}
        </div>
      )}
      <div
        id="we-recovery-tabpanel"
        role={showTabs ? 'tabpanel' : undefined}
        aria-labelledby={showTabs ? `we-recovery-tab-${selectedIndex}` : undefined}
      >
        <WorkflowDiffView
          before={(dlq.workflowJson ?? {}) as WorkflowDefinition}
          after={selected.workflow}
          beforeLabel="Current"
          afterLabel={showTabs ? `Suggested · ${APPROACH_LABEL_DISPLAY[selected.approachLabel] ?? selected.approachLabel}` : 'Suggested'}
          aiPatchRationale={selected.rationale}
        />
      </div>
    </>
  )
}

function ValidationFailedBody({
  suggestion,
  selectedIndex,
  dlq,
  runId,
  errorJson,
}: {
  suggestion: PatchSuggestion
  selectedIndex: number
  dlq: DeadLetter
  runId: string
  errorJson: unknown
}) {
  const message = pickErrorMessage(errorJson)
  const selected = suggestion.suggestions[selectedIndex] ?? suggestion.suggestions[0]!
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
        after={selected.workflow}
        beforeLabel="Current"
        afterLabel="Suggested (rejected)"
        aiPatchRationale={selected.rationale}
      />
    </>
  )
}

function AppliedBody({
  runId,
  cluster,
  appliedWorkflowId,
  appliedVersion,
  priorFailureSignature,
  preSaveBeforeSnapshot,
}: {
  runId?: string
  cluster?: ClusterApplyResult
  appliedWorkflowId?: string
  appliedVersion?: number
  priorFailureSignature?: string | null
  preSaveBeforeSnapshot?: PreSaveBeforeSnapshot | null
}) {
  const ribbon = cluster ? (
    (() => {
      const total = cluster.replayed + cluster.failed
      return (
        <div className="we-recovery-success" role="alert">
          <CheckCircle2 size={14} aria-hidden="true" />
          <div>
            <strong>Patch applied.</strong>
            {' '}Replayed {cluster.replayed} of {total}
            {cluster.failed > 0 ? `; ${cluster.failed} failed` : ''}.
            {cluster.errors.length > 0 ? (
              <details className="we-recovery-cluster-errors">
                <summary>Show per-row errors ({cluster.errors.length})</summary>
                <ul>
                  {cluster.errors.map((entry) => (
                    <li key={entry.deadLetterId}>
                      <code>{entry.deadLetterId.slice(0, 12)}…</code>
                      <span className="helper-text">{entry.error}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      )
    })()
  ) : (
    <div className="we-recovery-success" role="alert">
      <CheckCircle2 size={14} aria-hidden="true" />
      <div>
        <strong>Patch applied.</strong>
        {runId
          ? ` Replay started — run id ${runId.slice(0, 8)}…`
          : ' DLQ entry replayed.'}
      </div>
    </div>
  )

  // Mount the delta card alongside the ribbon when the save response
  // gave us the workflow id + version. Defensive fall-through to
  // ribbon-only when the save route returned an unexpected shape.
  if (!appliedWorkflowId || typeof appliedVersion !== 'number') {
    return ribbon
  }

  return (
    <div className="we-recovery-applied">
      {ribbon}
      <RecoveryDeltaCard
        workflowId={appliedWorkflowId}
        afterVersion={appliedVersion}
        priorFailureSignature={priorFailureSignature ?? null}
        preSaveBeforeSnapshot={preSaveBeforeSnapshot ?? null}
      />
    </div>
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

function isActionableSuggestion(
  currentWorkflow: unknown,
  suggestion: PatchSuggestion,
  selected: SuggestionTab,
): boolean {
  if (suggestion.mode !== 'ai') return false
  const diff = computeWorkflowDiff(toWorkflow(currentWorkflow), toWorkflow(selected.workflow))
  return diff.summary.totalChanges > 0
}

function toWorkflow(value: unknown): WorkflowDefinition {
  if (value && typeof value === 'object') return value as WorkflowDefinition
  return { dslVersion: '1.0', nodes: [], edges: [] }
}

/**
 * Normalise the patch-route response into the multi-suggestion shape.
 * The current route always emits `suggestions: [...]`, but older test
 * fixtures and a future cached response from before the upgrade might
 * still return only the legacy `{ mode, suggestedWorkflow, rationale }`
 * fields — fall back to a single-item array in that case so the dialog
 * code never has to branch on which shape it received.
 */
function normalisePatchSuggestion(raw: PatchSuggestion): PatchSuggestion {
  if (Array.isArray(raw.suggestions) && raw.suggestions.length > 0) {
    return raw
  }
  return {
    ...raw,
    suggestions: [{
      workflow: raw.suggestedWorkflow,
      rationale: raw.rationale,
      approachLabel: 'other',
      confidence: raw.mode === 'ai' ? 50 : 0,
    }],
  }
}
