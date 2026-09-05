// The recovery dialog's state machine: every step transition, the
// validation poll, the playbook match, the apply chain and the feedback
// writes. The dialog itself only renders the returned model.
import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeErrorSignature } from '@/lib/error-signature'
import { api, contractApi } from '../../api'
import { useWorkflowStore } from '../../store'
import type { DeadLetter } from '../dead-letter-types'
import { useT } from '../../i18n'
import { t as runtimeT } from '../../i18n/runtime'
import {
  isActionableSuggestion,
  normalisePatchSuggestion,
  pickFailedNodeErrorJson,
} from './recovery-dialog-model'
import type {
  ClusterApplyResult,
  PatchSuggestion,
  PreSaveBeforeSnapshot,
  RunStatusPayload,
  RecoveryPlaybookSummary,
  Step,
  SuggestionTab,
} from './types'

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const VALIDATION_POLL_INTERVAL_MS = 1500
// A sandbox run that never reaches a terminal status used to hold the
// dialog open forever: ESC, the backdrop and the close button are all
// disabled while validating, and the poll had no deadline. After this
// budget the dialog surfaces a recoverable error the operator can close
// or retry — the validation run itself is unaffected.
const VALIDATION_POLL_DEADLINE_MS = 5 * 60 * 1000

export type RecoveryDialogProps = {
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
  suggestionMode: 'ai' | 'fallback' | 'playbook'
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
}): Promise<boolean> {
  try {
    await api('/recovery/feedback', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return true
  } catch (error) {
    // Non-blocking — feedback is supplementary signal.
    console.warn('[recovery-feedback] write failed', error)
    return false
  }
}

export type RecoveryDialogModel = ReturnType<typeof useRecoveryDialogController>

export function useRecoveryDialogController({
  dlq,
  onClose,
  clusterMembers,
  clusterSignature,
  clusterMembersCapped,
  clusterMembersTotal,
}: RecoveryDialogProps) {
  const { t } = useT()
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [matchingPlaybook, setMatchingPlaybook] = useState<RecoveryPlaybookSummary | null>(null)
  const [playbookBusy, setPlaybookBusy] = useState<'use' | 'retire' | null>(null)

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
  const reviewSuggestions = step.kind === 'review' || step.kind === 'validated'
    ? step.suggestion.suggestions
    : []
  const safeSelectedIndex = Math.min(selectedSuggestionIndex, Math.max(reviewSuggestions.length - 1, 0))
  const selectedIndex = step.kind === 'validated' ? step.selectedIndex : safeSelectedIndex
  const selectedSuggestion: SuggestionTab | null = step.kind === 'review' || step.kind === 'validated'
    ? (reviewSuggestions[selectedIndex] ?? null)
    : null
  const canApplyPatch = (step.kind === 'review' || step.kind === 'validated') && selectedSuggestion
    ? isActionableSuggestion(dlq.workflowJson, step.suggestion, selectedSuggestion)
    : false

  // Focus the primary action on mount so keyboard users can hit Enter.
  useEffect(() => { primaryRef.current?.focus() }, [])

  // Offer only the server-derived exact workflow + signature match. A miss or
  // transient read failure never blocks the normal AI recovery path.
  useEffect(() => {
    const savedWorkflowId = (dlq.workflowJson as { id?: unknown } | null)?.id
    if (typeof savedWorkflowId !== 'string' || savedWorkflowId.length === 0) {
      setMatchingPlaybook(null)
      return
    }
    let cancelled = false
    api(`/recovery/playbooks/match?deadLetterId=${encodeURIComponent(dlq.id)}`)
      .then((result) => {
        if (!cancelled) setMatchingPlaybook((result as { playbook?: RecoveryPlaybookSummary | null }).playbook ?? null)
      })
      .catch(() => {
        if (!cancelled) setMatchingPlaybook(null)
      })
    return () => { cancelled = true }
  }, [dlq.id])

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
    const startedAt = Date.now()
    const poll = async () => {
      if (Date.now() - startedAt > VALIDATION_POLL_DEADLINE_MS) {
        cancelled = true
        setStep({
          kind: 'error',
          message: runtimeT('recoveryDialog.errors.validationTimedOut'),
        })
        return
      }
      try {
        const result = await contractApi('GET /run', `/run?runId=${encodeURIComponent(step.runId)}`, undefined) as unknown as RunStatusPayload
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
        let playbookRetired = false
        if (step.suggestion.playbook) {
          try {
            const outcome = await api(`/recovery/playbooks/${encodeURIComponent(step.suggestion.playbook.id)}/outcome`, {
              method: 'POST',
              body: JSON.stringify({ deadLetterId: dlq.id, validationRunId: step.runId, phase: 'validation' }),
            }) as { playbook?: RecoveryPlaybookSummary | null }
            if (outcome.playbook?.status === 'retired') {
              playbookRetired = true
              setMatchingPlaybook(null)
            }
          } catch (error) {
            console.warn('[recovery-playbook] validation outcome write failed', error)
          }
        }
        if (status === 'succeeded') {
          setSelectedSuggestionIndex(step.selectedIndex)
          setStep({
            kind: 'validated',
            suggestion: step.suggestion,
            selectedIndex: step.selectedIndex,
            runId: step.runId,
          })
          return
        }
        const errorJson = pickFailedNodeErrorJson(result.nodes ?? [], dlq.nodeId)
        setStep({
          kind: 'validation-failed',
          suggestion: step.suggestion,
          selectedIndex: step.selectedIndex,
          runId: step.runId,
          errorJson,
          playbookRetired,
        })
      } catch (error) {
        if (cancelled) return
        setStep({
          kind: 'error',
          message: error instanceof Error ? error.message : (runtimeT('recoveryDialog.errors.validationPolling')),
        })
      }
    }
    poll()
    const handle = window.setInterval(poll, VALIDATION_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [dlq.id, dlq.nodeId, step])

  const generateSuggestion = async () => {
    setStep({ kind: 'loading' })
    try {
      const result = await api('/ai/patch-workflow', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId: dlq.id }),
      }) as PatchSuggestion
      const normalised = normalisePatchSuggestion(result, dlq.recovery?.metadataWorkflowId)
      setSelectedSuggestionIndex(0)
      setStep({ kind: 'review', suggestion: normalised })
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : (t('recoveryDialog.errors.suggestionRequest')),
      })
    }
  }

  const loadMatchingPlaybook = async () => {
    if (!matchingPlaybook) return
    setPlaybookBusy('use')
    try {
      const result = await api(`/recovery/playbooks/${encodeURIComponent(matchingPlaybook.id)}/use`, {
        method: 'POST',
        body: JSON.stringify({ deadLetterId: dlq.id }),
      }) as { suggestion: PatchSuggestion }
      setSelectedSuggestionIndex(0)
      setStep({
        kind: 'review',
        suggestion: normalisePatchSuggestion(result.suggestion, dlq.recovery?.metadataWorkflowId),
      })
    } catch (error) {
      setStep({ kind: 'error', message: error instanceof Error ? error.message : (t('recoveryDialog.playbook.useFailed')) })
    } finally {
      setPlaybookBusy(null)
    }
  }

  const retireMatchingPlaybook = async () => {
    if (!matchingPlaybook) return
    setPlaybookBusy('retire')
    try {
      await api(`/recovery/playbooks/${encodeURIComponent(matchingPlaybook.id)}/retire`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setMatchingPlaybook(null)
      bumpPlatformVersion()
    } catch (error) {
      setStep({ kind: 'error', message: error instanceof Error ? error.message : (t('recoveryDialog.playbook.retireFailed')) })
    } finally {
      setPlaybookBusy(null)
    }
  }

  const validateSuggestion = async () => {
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
          ...(suggestion.playbook ? { recoveryPlaybookId: suggestion.playbook.id } : {}),
        }),
      }) as { runId: string }
      setStep({ kind: 'validating', suggestion, selectedIndex: safeSelectedIndex, runId: result.runId })
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : (t('recoveryDialog.errors.validationRequest')),
      })
    }
  }

  const applyAfterValidation = async (suggestion: PatchSuggestion, selectedIndex: number, validationRunId: string) => {
    const selected = suggestion.suggestions[selectedIndex]
    if (!selected) {
      setStep({ kind: 'error', message: t('recoveryDialog.errors.selectedSuggestionUnavailable') })
      return
    }
    const mode: 'single' | 'cluster' = isClusterMode ? 'cluster' : 'single'
    const total = isClusterMode ? clusterMembers!.length : undefined
    setStep({ kind: 'applying', mode, total })

    // Capture the pre-save snapshot of the workflow's current health so
    // the delta card can render the "before" pills statically without a
    // loading flash. Non-blocking: when this fails the card falls back
    // to fetching everything via /workflows/health/delta.
    // Recovery-list rows distinguish the source template/demo id from a
    // persisted workflow id. Only the explicit metadata id is eligible for
    // health reads; workflowJson.id may be a template id even when the row has
    // no recovery overlay yet. If this projection is unavailable, the delta
    // card fetches both sides after save instead of risking an expected 404.
    const targetWorkflowId = dlq.recovery?.metadataWorkflowId ?? null
    let preSaveBeforeSnapshot: PreSaveBeforeSnapshot | null = null
    if (targetWorkflowId) {
      try {
        const snapshot = await contractApi('GET /workflows/health', `/workflows/health?workflowId=${encodeURIComponent(targetWorkflowId)}`, undefined) as unknown as {
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
      const sourceWorkflowVersionId = typeof saveResponse.versionId === 'string' ? saveResponse.versionId : undefined
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
            // Apply the fix to same-workflow members so they recover, not just
            // re-run the broken snapshot; cross-workflow members re-run plainly.
            suggestedWorkflow: selected.workflow,
            ...(suggestion.playbook ? {
              recoveryPlaybookId: suggestion.playbook.id,
              recoveryValidationRunId: validationRunId,
              recoveryPlaybookDeadLetterId: dlq.id,
            } : {}),
          }),
        }) as ClusterApplyResult
        bumpPlatformVersion()
        // Operator → system feedback: Apply succeeded, so the operator
        // accepted this approach for THIS workflow. Future patch
        // suggestions for the same workflow will see this as accepted.
        // Passing `rationale` lets the api seed a `patch_rationale`
        // memory entry alongside the standard `recovery_rationale`.
        // Fire-and-forget: a feedback-write failure must not block the UX.
        const feedbackRecorded = await recordFeedback({
          deadLetterId: dlq.id,
          suggestionMode: suggestion.mode,
          approachLabel: selected.approachLabel,
          accepted: true,
          rationale: selected.rationale,
          rawConfidence: suggestion.mode === 'playbook' ? undefined : selected.confidence,
        })
        setStep({
          kind: 'applied',
          cluster: result,
          appliedWorkflowId,
          appliedVersion,
          priorFailureSignature,
          preSaveBeforeSnapshot,
          playbookUsePending: Boolean(suggestion.playbook),
          ...(!suggestion.playbook && feedbackRecorded && sourceWorkflowVersionId ? {
            playbookPromotionSource: {
              deadLetterId: dlq.id,
              validationRunId,
              sourceWorkflowVersionId,
              defaultTitle: t('recoveryDialog.playbook.defaultTitle', { nodeId: dlq.nodeId }),
              defaultInstructions: selected.rationale,
            },
          } : {}),
        })
        return
      }
      // Replay against the applied fix (not the original failed snapshot) so
      // the run actually recovers — the API validates it through the same gate
      // as the sandbox and writes it as the run's authoritative workflow.
      const replay = await api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({
          deadLetterId: dlq.id,
          suggestedWorkflow: selected.workflow,
          ...(suggestion.playbook ? {
            recoveryPlaybookId: suggestion.playbook.id,
            recoveryValidationRunId: validationRunId,
          } : {}),
        }),
      }) as { runId?: string }
      bumpPlatformVersion()
      addToast(t('toasts.deadLetterReplayed'), 'success')
      // Operator → system feedback: same as cluster mode above. The
      // `rationale` here seeds the `patch_rationale` memory kind so
      // future similar failures recall the LLM's explanation, not just
      // the approachLabel.
      const feedbackRecorded = await recordFeedback({
        deadLetterId: dlq.id,
        suggestionMode: suggestion.mode,
        approachLabel: selected.approachLabel,
        accepted: true,
        rationale: selected.rationale,
        rawConfidence: suggestion.mode === 'playbook' ? undefined : selected.confidence,
      })
      setStep({
        kind: 'applied',
        runId: replay.runId,
        appliedWorkflowId,
        appliedVersion,
        priorFailureSignature,
        preSaveBeforeSnapshot,
        playbookUsePending: Boolean(suggestion.playbook),
        ...(!suggestion.playbook && feedbackRecorded && sourceWorkflowVersionId ? {
          playbookPromotionSource: {
            deadLetterId: dlq.id,
            validationRunId,
            sourceWorkflowVersionId,
            defaultTitle: t('recoveryDialog.playbook.defaultTitle', { nodeId: dlq.nodeId }),
            defaultInstructions: selected.rationale,
          },
        } : {}),
      })
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : (t('recoveryDialog.errors.applyFailed')),
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

  // Every close path is blocked while async work is in flight, so an
  // operator cannot lose an in-progress save or skip the feedback write.
  const busy = step.kind === 'loading' || step.kind === 'applying' || step.kind === 'validating' || step.kind === 'cancelling'

  const startCancelling = () => {
    if (step.kind === 'review') {
      setStep({ kind: 'cancelling', suggestion: step.suggestion, selectedIndex: safeSelectedIndex, sourceStep: 'review' })
    } else if (step.kind === 'validated') {
      setStep({ kind: 'cancelling', suggestion: step.suggestion, selectedIndex: step.selectedIndex, sourceStep: 'validated', runId: step.runId })
    } else if (step.kind === 'validation-failed') {
      setStep({
        kind: 'cancelling', suggestion: step.suggestion, selectedIndex: step.selectedIndex, sourceStep: 'validation-failed',
        runId: step.runId, errorJson: step.errorJson, playbookRetired: step.playbookRetired,
      })
    }
  }

  const backFromCancelling = () => {
    if (step.kind !== 'cancelling') return
    if (step.sourceStep === 'review') {
      setStep({ kind: 'review', suggestion: step.suggestion })
    } else if (step.sourceStep === 'validated') {
      setStep({ kind: 'validated', suggestion: step.suggestion, selectedIndex: step.selectedIndex, runId: step.runId ?? '' })
    } else {
      setStep({
        kind: 'validation-failed', suggestion: step.suggestion, selectedIndex: step.selectedIndex,
        runId: step.runId ?? '', errorJson: step.errorJson, playbookRetired: step.playbookRetired,
      })
    }
  }

  // Every dialog decision is labeled: a rejection writes the feedback row
  // before closing.
  const submitRejection = (comment: string) => {
    if (step.kind !== 'cancelling') return
    const selected = step.suggestion.suggestions[step.selectedIndex]
    if (selected) {
      void recordFeedback({
        deadLetterId: dlq.id,
        suggestionMode: step.suggestion.mode,
        approachLabel: selected.approachLabel,
        accepted: false,
        comment: comment.length > 0 ? comment : undefined,
        rawConfidence: step.suggestion.mode === 'playbook' ? undefined : selected.confidence,
      })
    }
    onClose()
  }

  // Operator → system feedback: the operator chose to iterate because the
  // sandbox replay rejected this approach. Tag with the special
  // `validation_failed` marker so the prompt-enrichment helper can surface
  // "the operator iterated past this approach" distinct from "the operator
  // rejected it outright."
  const iterateAfterValidationFailure = () => {
    if (step.kind !== 'validation-failed') return
    const selected = step.suggestion.suggestions[step.selectedIndex]
    if (selected) {
      void recordFeedback({
        deadLetterId: dlq.id,
        suggestionMode: step.suggestion.mode,
        approachLabel: selected.approachLabel,
        accepted: false,
        comment: 'validation_failed',
        rawConfidence: step.suggestion.mode === 'playbook' ? undefined : selected.confidence,
      })
    }
    void generateSuggestion()
  }

  const retry = () => setStep({ kind: 'idle' })

  return {
    dlq,
    onClose,
    step,
    busy,
    matchingPlaybook,
    playbookBusy,
    isClusterMode,
    clusterMemberCount,
    clusterVisibleTotal,
    clusterMembersCapped,
    primaryRef,
    safeSelectedIndex,
    selectedSuggestion,
    canApplyPatch,
    priorFailureSignature,
    setSelectedSuggestionIndex,
    generateSuggestion,
    loadMatchingPlaybook,
    retireMatchingPlaybook,
    validateSuggestion,
    applyAfterValidation,
    onBackdropClick,
    startCancelling,
    backFromCancelling,
    submitRejection,
    iterateAfterValidationFailure,
    retry,
  }
}
