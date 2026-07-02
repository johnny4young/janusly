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
 * This parent owns the `Step` state machine, the three effects (focus,
 * ESC, the validation polling loop), and the apply-flow callbacks
 * (`generateSuggestion`, `validateAndApply`, `applyAfterValidation`,
 * `recordFeedback`, `onBackdropClick`). The pure helpers + the per-step
 * render bodies live under `./recovery-dialog/` (each body receives its
 * data via explicit props — no shared closures).
 *
 * Used by `DeadLettersPanel.tsx` — a Suggest-fix button per row mounts
 * this dialog with the selected DLQ row.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { AlertCircle, Play, RefreshCcw, Sparkles, X } from 'lucide-react'
import { normalizeErrorSignature } from '@janusly/shared/src/error-signature'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { DeadLetter } from './DeadLettersPanel'
import { Trans, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { AppliedBody } from './recovery-dialog/AppliedBody'
import { CancellingBody } from './recovery-dialog/CancellingBody'
import { ReviewBody } from './recovery-dialog/ReviewBody'
import { ValidationFailedBody } from './recovery-dialog/ValidationFailedBody'
import {
  isActionableSuggestion,
  normalisePatchSuggestion,
  pickFailedNodeErrorJson,
} from './recovery-dialog/helpers'
import type {
  ClusterApplyResult,
  PatchSuggestion,
  PreSaveBeforeSnapshot,
  RunStatusPayload,
  Step,
  SuggestionTab,
} from './recovery-dialog/types'

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


/**
 * Fire-and-forget POST to `/recovery/feedback`. Captures the operator's
 * accept/reject decision so the next patch suggestion for the same
 * workflow can deprioritize approaches that have already been
 * rejected. Failures are logged (console warn) but never surface to
 * the operator — the feedback is supplementary, losing one row is
 * better than blocking the apply chain on a transport error.
 */
async function recordFeedback(input: {
  deadLetterId: string
  suggestionMode: 'ai' | 'fallback'
  approachLabel: string
  accepted: boolean
  comment?: string
  /** LLM rationale for the suggestion. Passed on the apply-success path
   *  so the api can synthesize a `patch_rationale` memory entry alongside
   *  the `recovery_rationale` it always writes on accept. Cancel /
   *  iterate paths omit it. */
  rationale?: string
  /** The model's raw self-rated confidence (0-100) for the decided-on
   *  suggestion. Persisted on the `recovery_feedback` row so the daily
   *  confidence-calibration sweep can bucket decisions by raw confidence
   *  and fit the per-approach curve. Omitted by headless callers. */
  rawConfidence?: number
}): Promise<void> {
  try {
    await api('/recovery/feedback', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  } catch (error) {
    // Non-blocking — feedback is supplementary signal.
    console.warn('[recovery-feedback] write failed', error)
  }
}

export function RecoveryDialog({
  dlq,
  onClose,
  clusterMembers,
  clusterSignature,
  clusterMembersCapped,
  clusterMembersTotal,
}: RecoveryDialogProps) {
  const { t } = useT()
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
      // Detail rows carry the full nodeJson; list rows carry the summary
      // nodeType projection. Either yields the same signature input.
      nodeType: nodeJson?.type ?? dlq.nodeType ?? undefined,
    }).signature
  }, [dlq.errorJson, dlq.nodeId, dlq.nodeJson, dlq.nodeType])
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
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocusTrap(dialogRef)
  const reviewSuggestions = step.kind === 'review' ? step.suggestion.suggestions : []
  const safeSelectedIndex = Math.min(selectedSuggestionIndex, Math.max(reviewSuggestions.length - 1, 0))
  const selectedSuggestion: SuggestionTab | null = step.kind === 'review'
    ? (reviewSuggestions[safeSelectedIndex] ?? null)
    : null
  const canApplyPatch = step.kind === 'review' && selectedSuggestion
    ? isActionableSuggestion(dlq.workflowJson, step.suggestion, selectedSuggestion)
    : false

  // Two-step progress for cluster recovery so the validate-1-then-replay-N flow
  // reads as staged work, not a hung dialog. Visual only — the body line below
  // each step carries the live-region announcement.
  const renderClusterSteps = (active: 'validate' | 'replay') => (
    <ol className="we-recovery-cluster-steps" aria-hidden="true" data-testid="recovery-cluster-steps">
      <li data-state={active === 'validate' ? 'active' : 'done'}>
        {t('recoveryDialog.clusterProgress.validate')}
      </li>
      <li data-state={active === 'replay' ? 'active' : 'pending'}>
        {t('recoveryDialog.clusterProgress.replay', { total: clusterMemberCount })}
      </li>
    </ol>
  )

  // Focus the primary action on mount so keyboard users can hit Enter.
  useEffect(() => { primaryRef.current?.focus() }, [])

  // ESC closes — but only when no async work is in flight, otherwise
  // the operator could lose an in-progress save. The cancelling step
  // is also blocked: a fat-finger ESC there would silently close the
  // dialog without writing the rejection-feedback row, breaking the
  // recovery-loop contract that every dialog decision must be labeled.
  // The operator can use Skip & close, Submit & close, or Back from
  // the cancelling body itself.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (
        step.kind === 'loading'
        || step.kind === 'applying'
        || step.kind === 'validating'
        || step.kind === 'cancelling'
      ) return
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
          message: error instanceof Error ? error.message : (runtimeT('recoveryDialog.errors.validationPolling') as string),
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
        message: error instanceof Error ? error.message : (t('recoveryDialog.errors.suggestionRequest') as string),
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
        message: error instanceof Error ? error.message : (t('recoveryDialog.errors.validationRequest') as string),
      })
    }
  }

  const applyAfterValidation = async (suggestion: PatchSuggestion, selectedIndex: number) => {
    const selected = suggestion.suggestions[selectedIndex]
    if (!selected) {
      setStep({ kind: 'error', message: t('recoveryDialog.errors.selectedSuggestionUnavailable') as string })
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
        // Operator → system feedback: Apply succeeded, so the operator
        // accepted this approach for THIS workflow. Future patch
        // suggestions for the same workflow will see this as accepted.
        // Passing `rationale` lets the api seed a `patch_rationale`
        // memory entry alongside the standard `recovery_rationale`.
        // Fire-and-forget: a feedback-write failure must not block the UX.
        void recordFeedback({
          deadLetterId: dlq.id,
          suggestionMode: suggestion.mode,
          approachLabel: selected.approachLabel,
          accepted: true,
          rationale: selected.rationale,
          rawConfidence: selected.confidence,
        })
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
      // Operator → system feedback: same as cluster mode above. The
      // `rationale` here seeds the `patch_rationale` memory kind so
      // future similar failures recall the LLM's explanation, not just
      // the approachLabel.
      void recordFeedback({
        deadLetterId: dlq.id,
        suggestionMode: suggestion.mode,
        approachLabel: selected.approachLabel,
        accepted: true,
        rationale: selected.rationale,
        rawConfidence: selected.confidence,
      })
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : (t('recoveryDialog.errors.applyFailed') as string),
      })
    }
  }

  const onBackdropClick = () => {
    // Same guard as the ESC handler — cancelling has its own dedicated
    // close paths (Skip/Submit/Back) and the backdrop click would
    // otherwise silently bypass the feedback write.
    if (
      step.kind === 'loading'
      || step.kind === 'applying'
      || step.kind === 'validating'
      || step.kind === 'cancelling'
    ) return
    onClose()
  }

  return (
    <div className="run-input-backdrop" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
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
            <div className="section-kicker">{t('recoveryDialog.kicker')}</div>
            <h2 id="recovery-dialog-title">{t('recoveryDialog.titleRecover', { nodeId: dlq.nodeId, runIdShort: dlq.runId.slice(0, 8) })}</h2>
            <p className="helper-text">{t('recoveryDialog.description')}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onClose}
            aria-label={t('recoveryDialog.closeAria') as string}
            disabled={
              step.kind === 'loading'
              || step.kind === 'applying'
              || step.kind === 'validating'
              || step.kind === 'cancelling'
            }
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="run-input-dialog__body" aria-live="polite">
          {step.kind === 'idle' && (
            <p className="helper-text">
              {t('recoveryDialog.idle.failingNodeIs')} <code>{dlq.nodeId}</code> {t('recoveryDialog.idle.onRun')} <code>{dlq.runId.slice(0, 8)}…</code>{' '}
              {t('recoveryDialog.idle.afterAttempts', { count: dlq.attempt })}
              {isClusterMode ? (
                <>
                  {' '}{t('recoveryDialog.idle.clusterMatch')}{' '}
                  <strong>
                    {clusterMembersCapped
                      ? t('recoveryDialog.idle.clusterMatchOf', { visible: clusterMemberCount, total: clusterVisibleTotal })
                      : clusterMemberCount}
                  </strong>
                  {' '}{t('recoveryDialog.idle.clusterEntries', { count: clusterMemberCount })} —{' '}
                  {clusterMembersCapped
                    ? t('recoveryDialog.idle.clusterReplayCapped')
                    : t('recoveryDialog.idle.clusterReplayAll')}
                </>
              ) : null}
              {' '}<Trans i18nKey="recoveryDialog.idle.clickGenerate" components={{ strong: <strong /> }} />
            </p>
          )}

          {step.kind === 'loading' && (
            <p className="helper-text we-recovery-loading" aria-live="polite">
              {t('recoveryDialog.loading.analyzing')}
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
            <>
              {isClusterMode && renderClusterSteps('validate')}
              <p className="helper-text we-recovery-loading" aria-live="polite">
                {isClusterMode
                  ? t('recoveryDialog.validating.clusterBody', { total: clusterMemberCount })
                  : t('recoveryDialog.validating.body')}
              </p>
            </>
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

          {step.kind === 'cancelling' && (
            <CancellingBody
              dlq={dlq}
              suggestion={step.suggestion}
              selectedIndex={step.selectedIndex}
              onSubmit={(comment) => {
                const selected = step.suggestion.suggestions[step.selectedIndex]
                if (selected) {
                  void recordFeedback({
                    deadLetterId: dlq.id,
                    suggestionMode: step.suggestion.mode,
                    approachLabel: selected.approachLabel,
                    accepted: false,
                    comment: comment.length > 0 ? comment : undefined,
                    rawConfidence: selected.confidence,
                  })
                }
                onClose()
              }}
              onBack={() => {
                if (step.sourceStep === 'review') {
                  setStep({ kind: 'review', suggestion: step.suggestion })
                } else {
                  setStep({
                    kind: 'validation-failed',
                    suggestion: step.suggestion,
                    selectedIndex: step.selectedIndex,
                    runId: step.runId ?? '',
                    errorJson: step.errorJson,
                  })
                }
              }}
            />
          )}

          {step.kind === 'applying' && (
            <>
              {step.mode === 'cluster' && step.total ? renderClusterSteps('replay') : null}
              <p className="helper-text we-recovery-loading" aria-live="polite">
                {step.mode === 'cluster' && step.total
                  ? t('recoveryDialog.applying.clusterBody', { total: step.total })
                  : t('recoveryDialog.applying.singleBody')}
              </p>
            </>
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
                {t('recoveryDialog.footer.cancel')}
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="command-button command-button-primary"
                onClick={generateSuggestion}
              >
                <Sparkles size={14} aria-hidden="true" />
                <span>{t('recoveryDialog.footer.generate')}</span>
              </button>
            </>
          )}

          {step.kind === 'review' && (
            <>
              <button
                type="button"
                className="command-button"
                onClick={() => setStep({
                  kind: 'cancelling',
                  suggestion: step.suggestion,
                  selectedIndex: safeSelectedIndex,
                  sourceStep: 'review',
                })}
              >
                {t('recoveryDialog.footer.cancel')}
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="command-button command-button-primary"
                onClick={validateAndApply}
                disabled={!canApplyPatch}
                title={!canApplyPatch ? (t('recoveryDialog.footer.applyDisabledReason') as string) : undefined}
              >
                <Play size={14} aria-hidden="true" />
                <span>
                  {isClusterMode
                    ? t('recoveryDialog.footer.applyValidateCluster', { count: clusterMembers!.length })
                    : t('recoveryDialog.footer.applyValidate')}
                </span>
              </button>
            </>
          )}

          {step.kind === 'validation-failed' && (
            <>
              <button
                type="button"
                className="command-button"
                onClick={() => setStep({
                  kind: 'cancelling',
                  suggestion: step.suggestion,
                  selectedIndex: step.selectedIndex,
                  sourceStep: 'validation-failed',
                  runId: step.runId,
                  errorJson: step.errorJson,
                })}
              >
                {t('recoveryDialog.footer.cancel')}
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="command-button command-button-primary"
                onClick={() => {
                  // Operator → system feedback: the operator chose to
                  // iterate because the sandbox replay rejected this
                  // approach. Tag with the special `validation_failed`
                  // marker so the prompt-enrichment helper can surface
                  // "the operator iterated past this approach" distinct
                  // from "the operator rejected it outright."
                  const selected = step.suggestion.suggestions[step.selectedIndex]
                  if (selected) {
                    void recordFeedback({
                      deadLetterId: dlq.id,
                      suggestionMode: step.suggestion.mode,
                      approachLabel: selected.approachLabel,
                      accepted: false,
                      comment: 'validation_failed',
                      rawConfidence: selected.confidence,
                    })
                  }
                  generateSuggestion()
                }}
              >
                <RefreshCcw size={14} aria-hidden="true" />
                <span>{t('recoveryDialog.footer.iterate')}</span>
              </button>
            </>
          )}

          {step.kind === 'error' && (
            <>
              <button type="button" className="command-button" onClick={onClose}>
                {t('recoveryDialog.footer.close')}
              </button>
              <button
                type="button"
                ref={primaryRef}
                className="command-button command-button-primary"
                onClick={() => setStep({ kind: 'idle' })}
              >
                {t('recoveryDialog.footer.retry')}
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
              {t('recoveryDialog.footer.close')}
            </button>
          )}

          {(step.kind === 'loading' || step.kind === 'applying' || step.kind === 'validating') && (
            <button type="button" className="command-button" disabled>
              {t('recoveryDialog.footer.working')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
