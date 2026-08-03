/**
 * Failure-recovery dialog — shared data-shape types.
 *
 * Zero React, zero runtime logic: just the type vocabulary the dialog's
 * parent, pure helpers (`./helpers.ts`), and render bodies all share so
 * imports stay one-directional (parent + bodies → types, never back).
 *
 * Used by: apps/web/src/components/RecoveryDialog.tsx (the parent owns the
 * `Step` state machine + the apply-flow callbacks; the bodies render the
 * per-step UI). Re-exports `PreSaveBeforeSnapshot` from `RecoveryDeltaCard`
 * so consumers thread the delta-card snapshot type through one import.
 */

import type { EvidenceRow } from '@/lib/ai-evidence'
import type { WorkflowDefinition } from '../../types'
import type { PreSaveBeforeSnapshot } from '../RecoveryDeltaCard'

export type { PreSaveBeforeSnapshot }

export type PatchApproachLabel =
  | 'add_retry'
  | 'raise_timeout'
  | 'swap_secret_ref'
  | 'add_approval'
  | 'fix_url'
  | 'other'

export type FeedbackHealthState = 'active' | 'stale' | 'no_accepted_fix'

/** Read-only freshness signal returned with a patch response. */
export type FeedbackApproachHealth = {
  approachLabel: PatchApproachLabel
  feedbackLastSeen: string
  acceptedFixLastSeen: string | null
  acceptedFixAgeDays: number | null
  state: FeedbackHealthState
}

export type RecoveryFeedbackHealthSnapshot = {
  windowDays: number
  approaches: FeedbackApproachHealth[]
}

export type ConsideredAlternative = {
  approach: string
  rejectedBecause: string
}

export type SuggestionTab = {
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
  /** Server-derived from the canonical workflow-readiness sensitivity rule. */
  safety?: {
    writeSide: boolean
    approvalRequired: boolean
    approvalPresent: boolean
  }
  /** Model-authored trade-off summaries; never hidden chain-of-thought. */
  consideredAlternatives?: ConsideredAlternative[]
}

export type PriorSameSignatureOutcome = {
  status: string
  approachLabel: string | null
  declineReason: string | null
  occurredAt: string
}

export type PatchSuggestion = {
  mode: 'ai' | 'fallback' | 'playbook'
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
  /**
   * Feedback-loop freshness for the failing workflow. Optional so legacy or
   * cached patch responses remain renderable; the dialog hides the badge when
   * the read-only side channel is unavailable.
   */
  feedbackHealth?: RecoveryFeedbackHealthSnapshot
  recoveryPassport?: {
    failureSignature: string
    priorSameSignatureOutcome: PriorSameSignatureOutcome | null
  }
  model?: string
  provider?: string
  aiError?: string
  playbook?: RecoveryPlaybookSummary
}

export type RecoveryPlaybookSummary = {
  id: string
  workflowId: string | null
  signature: string
  version: number
  status: 'draft' | 'active' | 'retired'
  title: string
  instructionsMarkdown: string
  approachLabel: string
  successfulUses: number
  regressions: number
  lastValidatedAt: string | null
  activatedAt: string | null
  retiredAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type RecoveryPlaybookPromotionSource = {
  deadLetterId: string
  validationRunId: string
  sourceWorkflowVersionId: string
  defaultTitle: string
  defaultInstructions: string
}

export type ClusterApplyError = {
  deadLetterId: string
  error: string
}

export type ClusterApplyResult = {
  replayed: number
  failed: number
  errors: ClusterApplyError[]
  /** Summed (now − failure createdAt) across successfully replayed members. */
  downtimeEndedMs?: number
}

export type Step =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'review'; suggestion: PatchSuggestion }
  | { kind: 'validating'; suggestion: PatchSuggestion; selectedIndex: number; runId: string }
  | { kind: 'validated'; suggestion: PatchSuggestion; selectedIndex: number; runId: string }
  | { kind: 'validation-failed'; suggestion: PatchSuggestion; selectedIndex: number; runId: string; errorJson: unknown; playbookRetired?: boolean }
  | {
      kind: 'cancelling'
      suggestion: PatchSuggestion
      selectedIndex: number
      // Where the operator came from — drives the back button when they
      // change their mind. `validation-failed` returns to the failure
      // body; `review` returns to the diff.
      sourceStep: 'review' | 'validated' | 'validation-failed'
      // Validation-failed cancels carry the runId / errorJson so the
      // back button can restore the prior step without losing context.
      runId?: string
      errorJson?: unknown
      playbookRetired?: boolean
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
      playbookPromotionSource?: RecoveryPlaybookPromotionSource
      playbookUsePending?: boolean
    }
  | { kind: 'error'; message: string }

export type RunStatusPayload = {
  run?: { status?: string }
  nodes?: Array<{ nodeId?: string; status?: string; errorJson?: unknown }>
}
