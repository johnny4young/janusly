// The recovery dialog's state machine: every step transition, the
// validation poll, the playbook match, the apply chain and the feedback
// writes. The dialog itself only renders the returned model.
import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeErrorSignature } from '@/lib/error-signature'
import { api, contractApi } from '../../api'
import { parseRunStatusSnapshot } from '../../lib/run-status-contract'
import {
  parseRecoveryPatchSuggestion,
  parseRecoveryPlaybookUseResponse,
} from '../../lib/recovery-patch-contract'
import { isTerminalRunStatus } from '../../lib/status'
import { useWorkflowStore } from '../../store'
import type { DeadLetter } from '../dead-letter-types'
import { useT } from '../../i18n'
import { t as runtimeT } from '../../i18n/runtime'
import {
  isActionableSuggestion,
  pickFailedNodeErrorJson,
} from './recovery-dialog-model'
import type {
  ClusterApplyResult,
  PatchSuggestion,
  PreSaveBeforeSnapshot,
  RecoveryPlaybookSummary,
  Step,
  SuggestionTab,
} from './types'

const VALIDATION_POLL_INTERVAL_MS = 1500
// A sandbox run that never reaches a terminal status used to hold the
// dialog open forever: ESC, the backdrop and the close button are all
// disabled while validating, and the poll had no deadline. After this
// budget the dialog surfaces a recoverable error the operator can close
// or retry — the validation run itself is unaffected.
const VALIDATION_POLL_DEADLINE_MS = 5 * 60 * 1000

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

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
  const validationRequestPendingRef = useRef(false)
  const suggestionRequestPendingRef = useRef(false)
  const [matchingPlaybook, setMatchingPlaybook] = useState<RecoveryPlaybookSummary | null>(null)
  const [playbookBusy, setPlaybookBusy] = useState<'use' | 'retire' | null>(null)
  const busy = step.kind === 'loading' || step.kind === 'applying' || step.kind === 'validating' || step.kind === 'cancelling' || playbookBusy !== null

  // Only entering a fresh review releases the synchronous request claim.
  // Keep it held across the request → polling transition.
  const enterReview = (suggestion: PatchSuggestion) => {
    validationRequestPendingRef.current = false
    setSelectedSuggestionIndex(0)
    setStep({ kind: 'review', suggestion })
  }

  // Derive the original failure's signature once when the source DLQ
  // mounts. The delta route uses this to count "same failure since
  // Apply" — if the operator's fix worked, that count stays at 0.
  // Defense-in-depth: the helper scrubs token-shaped substrings before
  // returning, so the signature surfaced through the URL is safe.
  const persistedWorkflowId = useMemo(() => {
    const metadataWorkflowId = dlq.recovery?.metadataWorkflowId
    if (typeof metadataWorkflowId === 'string' && metadataWorkflowId.length > 0) return metadataWorkflowId
    const snapshotWorkflowId = (dlq.workflowJson as { id?: unknown } | null)?.id
    return typeof snapshotWorkflowId === 'string' && snapshotWorkflowId.length > 0
      ? snapshotWorkflowId
      : null
  }, [dlq.recovery?.metadataWorkflowId, dlq.workflowJson])

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

  // Offer only the server-derived exact workflow + signature match. A miss or
  // transient read failure never blocks the normal AI recovery path.
  useEffect(() => {
    if (!persistedWorkflowId) {
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
  }, [dlq.id, persistedWorkflowId])

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
      if (busy) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, busy])

  // Poll the validation run until it reaches a terminal status. The poll
  // tears itself down when the dialog closes or the step transitions
  // away from `validating`, so a long-running validation can't leak
  // requests after the operator dismisses the dialog.
  useEffect(() => {
    if (step.kind !== 'validating' || !step.runId) return
    const validationRunId = step.runId
    let cancelled = false
    const startedAt = Date.now()
    const poll = async () => {
      if (Date.now() - startedAt > VALIDATION_POLL_DEADLINE_MS) {
        cancelled = true
        setStep({
          kind: 'error',
          message: runtimeT('recoveryDialog.errors.validationTimedOut'),
          suggestion: step.suggestion,
        })
        return
      }
      try {
        const payload = await contractApi('GET /run', `/run?runId=${encodeURIComponent(validationRunId)}`, undefined)
        if (cancelled) return
        const result = parseRunStatusSnapshot(payload, validationRunId)
        if (!result) throw new Error(runtimeT('api.error.malformedResponse'))
        const status = result.run.status
        if (!isTerminalRunStatus(status)) {
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
              body: JSON.stringify({ deadLetterId: dlq.id, validationRunId, phase: 'validation' }),
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
            runId: validationRunId,
          })
          return
        }
        const errorJson = pickFailedNodeErrorJson(result.nodes, dlq.nodeId)
        setStep({
          kind: 'validation-failed',
          suggestion: step.suggestion,
          selectedIndex: step.selectedIndex,
          runId: validationRunId,
          errorJson,
          playbookRetired,
        })
      } catch (error) {
        if (cancelled) return
        setStep({
          kind: 'error',
          message: errorMessage(error, runtimeT('recoveryDialog.errors.validationPolling')),
          suggestion: step.suggestion,
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
    if (suggestionRequestPendingRef.current) return
    suggestionRequestPendingRef.current = true
    setStep({ kind: 'loading' })
    try {
      const result = await api('/ai/patch-workflow', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId: dlq.id }),
      })
      const normalised = parseRecoveryPatchSuggestion(result, {
        persistedWorkflowId,
        expectedFailureSignature: priorFailureSignature,
      })
      if (!normalised) throw new Error(runtimeT('api.error.malformedResponse'))
      enterReview(normalised)
    } catch (error) {
      setStep({
        kind: 'error',
        message: errorMessage(error, t('recoveryDialog.errors.suggestionRequest')),
      })
    } finally {
      suggestionRequestPendingRef.current = false
    }
  }

  const loadMatchingPlaybook = async () => {
    if (!matchingPlaybook || suggestionRequestPendingRef.current) return
    suggestionRequestPendingRef.current = true
    setPlaybookBusy('use')
    try {
      const result = await api(`/recovery/playbooks/${encodeURIComponent(matchingPlaybook.id)}/use`, {
        method: 'POST',
        body: JSON.stringify({ deadLetterId: dlq.id }),
      })
      const suggestion = parseRecoveryPlaybookUseResponse(result, {
        persistedWorkflowId,
        expectedFailureSignature: priorFailureSignature,
        expectedPlaybookId: matchingPlaybook.id,
      })
      if (!suggestion) throw new Error(runtimeT('api.error.malformedResponse'))
      enterReview(suggestion)
    } catch (error) {
      setStep({ kind: 'error', message: errorMessage(error, t('recoveryDialog.playbook.useFailed')) })
    } finally {
      setPlaybookBusy(null)
      suggestionRequestPendingRef.current = false
    }
  }

  const retireMatchingPlaybook = async () => {
    if (!matchingPlaybook || suggestionRequestPendingRef.current) return
    suggestionRequestPendingRef.current = true
    setPlaybookBusy('retire')
    try {
      await api(`/recovery/playbooks/${encodeURIComponent(matchingPlaybook.id)}/retire`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setMatchingPlaybook(null)
      bumpPlatformVersion()
    } catch (error) {
      setStep({ kind: 'error', message: errorMessage(error, t('recoveryDialog.playbook.retireFailed')) })
    } finally {
      setPlaybookBusy(null)
      suggestionRequestPendingRef.current = false
    }
  }

  const validateSuggestion = async () => {
    if (step.kind !== 'review' || validationRequestPendingRef.current) return
    const suggestion = step.suggestion
    const selected = suggestion.suggestions[safeSelectedIndex]
    if (!selected) return
    validationRequestPendingRef.current = true
    setStep({ kind: 'validating', suggestion, selectedIndex: safeSelectedIndex, runId: null })
    const requestSignal = AbortSignal.timeout(60_000)
    try {
      const result = await api('/dlq/validate-fix', {
        method: 'POST',
        signal: requestSignal,
        body: JSON.stringify({
          deadLetterId: dlq.id,
          suggestedWorkflow: selected.workflow,
          ...(suggestion.playbook ? { recoveryPlaybookId: suggestion.playbook.id } : {}),
        }),
      }) as { runId?: unknown } | null
      if (requestSignal.aborted) throw requestSignal.reason
      if (typeof result?.runId !== 'string' || !result.runId) throw new Error(runtimeT('api.error.malformedResponse'))
      setStep({ kind: 'validating', suggestion, selectedIndex: safeSelectedIndex, runId: result.runId })
    } catch (error) {
      setStep({
        kind: 'error',
        message: requestSignal.aborted
          ? t('recoveryDialog.errors.validationTimedOut')
          : errorMessage(error, t('recoveryDialog.errors.validationRequest')),
        suggestion,
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
        const snapshot: {
          score?: number
          status?: string
          signals?: { p95LatencyMs?: number | null; totalRuns?: number; totalCostUsd?: number }
        } = await contractApi('GET /workflows/health', `/workflows/health?workflowId=${encodeURIComponent(targetWorkflowId)}`, undefined)
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
      let applyOutcome: { runId?: string; cluster?: ClusterApplyResult }
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
        applyOutcome = { cluster: result }
      } else {
        // Replay the applied fix, not the original failed snapshot.
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
        applyOutcome = { runId: replay.runId }
        addToast(t('toasts.deadLetterReplayed'), 'success')
      }
      bumpPlatformVersion()
      // Both apply modes make the same operator decision durable. A feedback
      // failure cannot undo the workflow save or the production replay.
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
        ...applyOutcome,
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
        message: errorMessage(error, t('recoveryDialog.errors.applyFailed')),
      })
    }
  }

  const onBackdropClick = () => {
    // Same guard as the ESC handler — cancelling has its own dedicated
    // close paths (Skip/Submit/Back) and the backdrop click would
    // otherwise silently bypass the feedback write.
    if (busy) return
    onClose()
  }

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
  const rejectSuggestion = (suggestion: PatchSuggestion, index: number, comment?: string) => {
    const selected = suggestion.suggestions[index]
    if (!selected) return
    void recordFeedback({
      deadLetterId: dlq.id,
      suggestionMode: suggestion.mode,
      approachLabel: selected.approachLabel,
      accepted: false,
      comment,
      rawConfidence: suggestion.mode === 'playbook' ? undefined : selected.confidence,
    })
  }

  const submitRejection = (comment: string) => {
    if (step.kind !== 'cancelling') return
    rejectSuggestion(step.suggestion, step.selectedIndex, comment || undefined)
    onClose()
  }

  // Operator → system feedback: the operator chose to iterate because the
  // sandbox replay rejected this approach. Tag with the special
  // `validation_failed` marker so the prompt-enrichment helper can surface
  // "the operator iterated past this approach" distinct from "the operator
  // rejected it outright."
  const iterateAfterValidationFailure = () => {
    if (step.kind !== 'validation-failed') return
    rejectSuggestion(step.suggestion, step.selectedIndex, 'validation_failed')
    void generateSuggestion()
  }

  // A failed or ambiguous validation must not silently spend another AI call.
  // Return to the same patch for an explicit review and validation decision.
  const retry = () => {
    if (step.kind === 'error' && step.suggestion) {
      validationRequestPendingRef.current = false
      setStep({ kind: 'review', suggestion: step.suggestion })
      return
    }
    setStep({ kind: 'idle' })
  }

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
