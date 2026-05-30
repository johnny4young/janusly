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
import { scrubEvidenceRow, type EvidenceKind, type EvidenceRow } from '@janusly/shared/src/ai-evidence'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import { WorkflowDiffView } from './WorkflowDiffView'
import { RecoveryDeltaCard, type PreSaveBeforeSnapshot } from './RecoveryDeltaCard'
import type { DeadLetter } from './DeadLettersPanel'
import { Trans, useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'

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
  /** The model's raw self-rated confidence (0-100). */
  confidence: number
  /**
   * The calibrated confidence (0-100) — `confidence` mapped through the
   * org's per-approach curve server-side. Equals `confidence` when no
   * calibration is available (disabled / no fit yet / below the sample
   * threshold). Optional so pre-calibration cached responses and legacy
   * fixtures still parse; the renderer falls back to `confidence` when
   * absent.
   */
  calibratedConfidence?: number
}

/**
 * Minimum gap (in confidence points) between the calibrated and raw
 * values before the "(model self-rated X%)" subtitle is shown. Mirrors
 * `CALIBRATION_SUBTITLE_DELTA` in `@janusly/engine/src/confidence-calibration.ts`
 * (kept as a local literal because the web bundle can't import engine).
 */
const CALIBRATION_SUBTITLE_DELTA = 10

type PatchSuggestion = {
  mode: 'ai' | 'fallback'
  /** Legacy mirror of `suggestions[0]` — kept so older test fixtures and callers still work. */
  suggestedWorkflow: WorkflowDefinition
  /** Legacy mirror of `suggestions[0].rationale`. */
  rationale: string
  /** 1-3 alternative patches sorted by confidence desc. The route guarantees length ≥ 1. */
  suggestions: SuggestionTab[]
  /**
   * "Why this suggestion?" evidence — the context the prompt composer fed
   * the model (past feedback, recalled memory, runbook excerpt, recent
   * similar errors, the fired signature rule, the tool input contract).
   * Optional so pre-evidence cached responses + legacy fixtures still parse;
   * the renderer treats `undefined` as `[]` and hides the panel.
   */
  evidence?: EvidenceRow[]
  model?: string
  provider?: string
  aiError?: string
}

function approachLabelDisplay(label: PatchApproachLabel): string {
  switch (label) {
    case 'add_retry': return runtimeT('recoveryDialog.approachLabel.add_retry') as string
    case 'raise_timeout': return runtimeT('recoveryDialog.approachLabel.raise_timeout') as string
    case 'swap_secret_ref': return runtimeT('recoveryDialog.approachLabel.swap_secret_ref') as string
    case 'add_approval': return runtimeT('recoveryDialog.approachLabel.add_approval') as string
    case 'fix_url': return runtimeT('recoveryDialog.approachLabel.fix_url') as string
    case 'other': return runtimeT('recoveryDialog.approachLabel.other') as string
  }
}

/** Human label for an evidence kind, localized. */
function evidenceKindLabel(kind: EvidenceKind): string {
  switch (kind) {
    case 'recovery_feedback': return runtimeT('recoveryDialog.evidence.kind.recovery_feedback') as string
    case 'memory_entry': return runtimeT('recoveryDialog.evidence.kind.memory_entry') as string
    case 'runbook_excerpt': return runtimeT('recoveryDialog.evidence.kind.runbook_excerpt') as string
    case 'recent_error': return runtimeT('recoveryDialog.evidence.kind.recent_error') as string
    case 'signature_rule': return runtimeT('recoveryDialog.evidence.kind.signature_rule') as string
    case 'tool_contract': return runtimeT('recoveryDialog.evidence.kind.tool_contract') as string
  }
}

/**
 * Collapsible "Why this suggestion?" panel. Renders one chip per evidence
 * row, grouped visually by `kind` via a `data-evidence-kind` attribute the
 * CSS colours. Each row's `sourceRef` is shown as a monospace deep-link
 * token (run id, recovery item id, memory entry id, tool name, signature
 * category) so the operator can trace the suggestion back to its source.
 *
 * Defense in depth: every row re-passes through the shared `scrubEvidenceRow`
 * at render time even though the API already scrubbed at read time — the
 * AC's "scrubbed at read even though scrubbed at write" applies on the
 * browser side too. An empty list hides the panel entirely.
 */
function EvidencePanel({ evidence }: { evidence: readonly EvidenceRow[] }) {
  const { t } = useT()
  // Re-scrub at render (cheap, idempotent) and drop any row that scrubbed
  // down to an empty snippet. Memoized so a re-render of the tabpanel (e.g.
  // switching suggestion tabs) doesn't re-walk the list each time.
  const rows = useMemo(
    () => evidence.map((row) => scrubEvidenceRow(row)).filter((row) => row.snippet.length > 0),
    [evidence],
  )
  if (rows.length === 0) return null
  return (
    <details className="we-recovery-evidence">
      <summary className="we-recovery-evidence__summary">
        {t('recoveryDialog.evidence.summary', { count: rows.length })}
      </summary>
      <ul className="we-recovery-evidence__list">
        {rows.map((row, index) => (
          <li
            key={`${row.kind}:${row.sourceRef}:${index}`}
            className="we-recovery-evidence__row"
            data-evidence-kind={row.kind}
          >
            <span className="we-recovery-evidence__kind">{row.label || evidenceKindLabel(row.kind)}</span>
            <span className="we-recovery-evidence__snippet">{row.snippet}</span>
            <code className="we-recovery-evidence__ref" title={t('recoveryDialog.evidence.sourceRefTitle') as string}>
              {row.sourceRef}
            </code>
          </li>
        ))}
      </ul>
    </details>
  )
}

function suggestionTabKey(tab: SuggestionTab): string {
  const nodeFingerprint = tab.workflow.nodes.map((node) => `${node.id}:${node.type}`).join(',')
  const edgeFingerprint = tab.workflow.edges
    .map((edge) => `${edge.from}->${edge.to}:${edge.condition ?? ''}`)
    .join(',')

  return [
    tab.workflow.id ?? tab.workflow.name ?? 'workflow',
    tab.approachLabel,
    tab.confidence,
    nodeFingerprint,
    edgeFingerprint,
    tab.rationale,
  ].join('|')
}

/**
 * Resolve the confidence numbers a suggestion tab renders. The primary
 * number is the server-calibrated confidence (falling back to the raw
 * self-rating when no calibration is available). The raw self-rating is
 * surfaced as a subtitle ONLY when it diverges from the calibrated value
 * by at least `CALIBRATION_SUBTITLE_DELTA` points — a negligible
 * correction stays a single clean number.
 */
function resolveConfidenceDisplay(tab: SuggestionTab): {
  primary: number
  showSelfRated: boolean
  selfRated: number
} {
  const raw = tab.confidence
  const calibrated = typeof tab.calibratedConfidence === 'number' ? tab.calibratedConfidence : raw
  return {
    primary: calibrated,
    showSelfRated: Math.abs(calibrated - raw) >= CALIBRATION_SUBTITLE_DELTA,
    selfRated: raw,
  }
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
  | {
      kind: 'cancelling'
      suggestion: PatchSuggestion
      selectedIndex: number
      // Where the operator came from — drives the back button when they
      // change their mind. `validation-failed` returns to the failure
      // body; `review` returns to the diff.
      sourceStep: 'review' | 'validation-failed'
      // Validation-failed cancels carry the runId / errorJson so the
      // back button can restore the prior step without losing context.
      runId?: string
      errorJson?: unknown
    }
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

/**
 * Closed enum of quick-pick reasons shown as chips in the cancel UX.
 * Clicking a chip writes a feedback row with `comment = chip.id` (the
 * canonical English value, kept stable for server-side analytics) and
 * closes the dialog. The chip's display label is translated via
 * `chip.labelKey`. The operator can also type a free-text comment
 * below the chips, or skip and close with no comment.
 */
const CANCEL_REASON_CHIPS = [
  { id: 'Wrong approach', labelKey: 'recoveryDialog.cancelling.chip.wrongApproach' },
  { id: "Doesn't fix root cause", labelKey: 'recoveryDialog.cancelling.chip.doesntFix' },
  { id: 'Risky', labelKey: 'recoveryDialog.cancelling.chip.risky' },
  { id: 'Too narrow', labelKey: 'recoveryDialog.cancelling.chip.tooNarrow' },
  { id: 'Other', labelKey: 'recoveryDialog.cancelling.chip.other' },
] as const

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

        <div className="run-input-dialog__body">
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
            <p className="helper-text we-recovery-loading" aria-live="polite">
              {t('recoveryDialog.validating.body')}
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
            <p className="helper-text we-recovery-loading" aria-live="polite">
              {step.mode === 'cluster' && step.total
                ? t('recoveryDialog.applying.clusterBody', { total: step.total })
                : t('recoveryDialog.applying.singleBody')}
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
  const { t } = useT()
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
            <strong>{t('recoveryDialog.review.aiUnavailable')}</strong> {t('recoveryDialog.review.aiUnavailableBody')}
            {suggestion.aiError ? ` ${t('recoveryDialog.review.aiUnavailableReason', { reason: suggestion.aiError })}` : null}
          </div>
        </div>
      )}
      {suggestion.mode === 'ai' && !canApplyPatch && (
        <div className="we-recovery-warning" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <div>
            <strong>{t('recoveryDialog.review.noStructuralPatch')}</strong> {t('recoveryDialog.review.noStructuralPatchBody')}
          </div>
        </div>
      )}
      {showTabs && (
        <div className="we-recovery-tabs" role="tablist" aria-label={t('recoveryDialog.review.tabsAriaLabel') as string}>
          {tabs.map((tab, index) => (
            <button
              key={suggestionTabKey(tab)}
              type="button"
              role="tab"
              id={`we-recovery-tab-${index}`}
              aria-controls="we-recovery-tabpanel"
              aria-selected={index === selectedIndex}
              tabIndex={index === selectedIndex ? 0 : -1}
              className={`we-recovery-tab${index === selectedIndex ? ' we-recovery-tab--active' : ''}`}
              onClick={() => onSelectIndex(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              title={(() => {
                const { primary, showSelfRated, selfRated } = resolveConfidenceDisplay(tab)
                return showSelfRated
                  ? t('recoveryDialog.review.tabCalibratedTitle', { confidence: primary, selfRated }) as string
                  : t('recoveryDialog.review.tabConfidenceTitle', { confidence: primary }) as string
              })()}
            >
              <span className="we-recovery-tab__label">{approachLabelDisplay(tab.approachLabel)}</span>
              {(() => {
                const { primary, showSelfRated, selfRated } = resolveConfidenceDisplay(tab)
                return (
                  <span className="we-recovery-tab__confidence">
                    <span className="we-recovery-tab__confidence-primary">{primary}%</span>
                    {showSelfRated && (
                      <span className="we-recovery-tab__confidence-self">
                        {t('recoveryDialog.review.selfRated', { confidence: selfRated })}
                      </span>
                    )}
                  </span>
                )
              })()}
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
          beforeLabel={t('recoveryDialog.review.beforeLabel') as string}
          afterLabel={showTabs
            ? (t('recoveryDialog.review.suggestedLabelWithApproach', { approach: approachLabelDisplay(selected.approachLabel) }) as string)
            : (t('recoveryDialog.review.suggestedLabel') as string)}
          aiPatchRationale={selected.rationale}
        />
        <EvidencePanel evidence={suggestion.evidence ?? []} />
      </div>
    </>
  )
}

/**
 * The cancel UX step. Operator landed here because they pressed Cancel
 * from the review or validation-failed step — they're rejecting the
 * suggestion. We capture WHY in two layers:
 *
 *   1. A row of 5 quick-pick chips (`CANCEL_REASON_CHIPS`) — clicking
 *      one auto-fills the comment and submits in a single click.
 *   2. A free-text textarea below — for reasons the chips don't cover.
 *
 * "Skip & close" submits with no comment (the operator just wanted out)
 * — the row still gets written with `accepted: false` so the count is
 * accurate, but there's no qualitative reason. "Back" returns to the
 * source step (review or validation-failed) without writing anything.
 *
 * The component itself doesn't talk to the API; the parent's `onSubmit`
 * handles the write so the dialog stays as the single owner of network
 * side effects.
 */
function CancellingBody({
  dlq,
  suggestion,
  selectedIndex,
  onSubmit,
  onBack,
}: {
  dlq: DeadLetter
  suggestion: PatchSuggestion
  selectedIndex: number
  onSubmit: (comment: string) => void
  onBack: () => void
}) {
  const { t } = useT()
  const [comment, setComment] = useState('')
  const selected = suggestion.suggestions[selectedIndex]
  const approachLabel = selected ? approachLabelDisplay(selected.approachLabel) : (t('recoveryDialog.cancelling.thisApproach') as string)

  return (
    <div className="we-recovery-cancelling">
      <p className="helper-text">
        {t('recoveryDialog.cancelling.questionPrefix')} <strong>{approachLabel}</strong> {t('recoveryDialog.cancelling.questionSuffix')}{' '}
        <code>{dlq.nodeId}</code>{t('recoveryDialog.cancelling.questionTail')}
      </p>
      <div className="we-recovery-cancelling__chips" role="group" aria-label={t('recoveryDialog.cancelling.chipsAriaLabel') as string}>
        {CANCEL_REASON_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="we-recovery-cancelling__chip"
            onClick={() => onSubmit(chip.id)}
          >
            {t(chip.labelKey)}
          </button>
        ))}
      </div>
      <label className="we-recovery-cancelling__label" htmlFor="recovery-cancel-comment">
        {t('recoveryDialog.cancelling.commentLabel')}
      </label>
      <textarea
        id="recovery-cancel-comment"
        className="we-recovery-cancelling__textarea"
        value={comment}
        maxLength={2000}
        onChange={(event) => setComment(event.target.value)}
        rows={3}
        placeholder={t('recoveryDialog.cancelling.commentPlaceholder') as string}
      />
      <div className="we-recovery-cancelling__actions">
        <button
          type="button"
          className="we-recovery-cancelling__skip"
          onClick={() => onSubmit('')}
        >
          {t('recoveryDialog.cancelling.skipClose')}
        </button>
        <div className="we-recovery-cancelling__primary">
          <button type="button" className="command-button" onClick={onBack}>
            {t('recoveryDialog.cancelling.back')}
          </button>
          <button
            type="button"
            className="command-button command-button-primary"
            onClick={() => onSubmit(comment.trim())}
            disabled={comment.trim().length === 0}
          >
            {t('recoveryDialog.cancelling.submitClose')}
          </button>
        </div>
      </div>
    </div>
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
  const { t } = useT()
  const message = pickErrorMessage(errorJson)
  const selected = suggestion.suggestions[selectedIndex] ?? suggestion.suggestions[0]!
  return (
    <>
      <div className="we-recovery-warning" role="alert">
        <AlertCircle size={14} aria-hidden="true" />
        <div>
          <strong>{t('recoveryDialog.validationFailed.title')}</strong>{' '}
          <Trans
            i18nKey="recoveryDialog.validationFailed.body"
            values={{ runIdShort: runId.slice(0, 8) }}
            components={{ strong: <strong />, code: <code /> }}
          />
        </div>
      </div>
      {message ? (
        <pre className="we-recovery-error-detail" aria-label={t('recoveryDialog.validationFailed.errorDetailAria') as string}>
          {message}
        </pre>
      ) : null}
      <WorkflowDiffView
        before={(dlq.workflowJson ?? {}) as WorkflowDefinition}
        after={selected.workflow}
        beforeLabel={t('recoveryDialog.review.beforeLabel') as string}
        afterLabel={t('recoveryDialog.validationFailed.suggestedRejected') as string}
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
  const { t } = useT()
  const ribbon = cluster ? (
    (() => {
      const total = cluster.replayed + cluster.failed
      return (
        <div className="we-recovery-success" role="alert">
          <CheckCircle2 size={14} aria-hidden="true" />
          <div>
            <strong>{t('recoveryDialog.applied.title')}</strong>
            {' '}{t('recoveryDialog.applied.replayedNofM', { replayed: cluster.replayed, total })}
            {cluster.failed > 0 ? `; ${t('recoveryDialog.applied.numFailed', { count: cluster.failed })}` : ''}.
            {cluster.errors.length > 0 ? (
              <details className="we-recovery-cluster-errors">
                <summary>{t('recoveryDialog.applied.showRowErrors', { count: cluster.errors.length })}</summary>
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
        <strong>{t('recoveryDialog.applied.title')}</strong>{' '}
        {runId
          ? t('recoveryDialog.applied.runStarted', { runIdShort: runId.slice(0, 8) })
          : t('recoveryDialog.applied.dlqReplayed')}
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
      // No server-side calibration on the legacy shape — mirror raw so the
      // renderer shows a single number (delta is 0, subtitle suppressed).
      calibratedConfidence: raw.mode === 'ai' ? 50 : 0,
    }],
  }
}
