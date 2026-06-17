/**
 * Failure-recovery dialog — pure helpers.
 *
 * Zero React: every function here is deterministic. The label helpers call
 * the non-React translation accessor `runtimeT` (the same accessor the
 * parent used inline before the split), so they need no `t` argument. The
 * shape/diff helpers (`isActionableSuggestion`, `toWorkflow`,
 * `normalisePatchSuggestion`, `pick*`) are render-free transforms.
 *
 * Used by: apps/web/src/components/RecoveryDialog.tsx and its render bodies
 * under `./` (ReviewBody, ValidationFailedBody). Owns the
 * confidence-display + suggestion-normalisation + error-extraction logic.
 */

import { computeWorkflowDiff } from '@janusly/shared/src/workflow-diff'
import type { EvidenceKind } from '@janusly/shared/src/ai-evidence'
import { t as runtimeT } from '../../i18n/runtime'
import type { WorkflowDefinition } from '../../types'
import type {
  PatchApproachLabel,
  PatchSuggestion,
  RunStatusPayload,
  SuggestionTab,
} from './types'

/**
 * Minimum gap (in confidence points) between the calibrated and raw
 * values before the "(model self-rated X%)" subtitle is shown. Mirrors
 * `CALIBRATION_SUBTITLE_DELTA` in `@janusly/engine/src/confidence-calibration.ts`
 * (kept as a local literal because the web bundle can't import engine).
 */
export const CALIBRATION_SUBTITLE_DELTA = 10

export function approachLabelDisplay(label: PatchApproachLabel): string {
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
export function evidenceKindLabel(kind: EvidenceKind): string {
  switch (kind) {
    case 'recovery_feedback': return runtimeT('recoveryDialog.evidence.kind.recovery_feedback') as string
    case 'memory_entry': return runtimeT('recoveryDialog.evidence.kind.memory_entry') as string
    case 'runbook_excerpt': return runtimeT('recoveryDialog.evidence.kind.runbook_excerpt') as string
    case 'recent_error': return runtimeT('recoveryDialog.evidence.kind.recent_error') as string
    case 'signature_rule': return runtimeT('recoveryDialog.evidence.kind.signature_rule') as string
    case 'tool_contract': return runtimeT('recoveryDialog.evidence.kind.tool_contract') as string
  }
}

export function suggestionTabKey(tab: SuggestionTab): string {
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
export function resolveConfidenceDisplay(tab: SuggestionTab): {
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

export function pickFailedNodeErrorJson(nodes: RunStatusPayload['nodes'], failingNodeId: string): unknown {
  if (!nodes) return null
  // Prefer the originally-failing node's error so the operator sees the
  // reason their proposed fix didn't unstick the run; fall back to any
  // failed node's error if some downstream step blew up instead.
  const focus = nodes.find((n) => n.nodeId === failingNodeId && n.status === 'failed')
  if (focus?.errorJson) return focus.errorJson
  const anyFailed = nodes.find((n) => n.status === 'failed')
  return anyFailed?.errorJson ?? null
}

export function pickErrorMessage(errorJson: unknown): string | null {
  if (!errorJson || typeof errorJson !== 'object') return null
  const candidate = (errorJson as { message?: unknown }).message
  if (typeof candidate === 'string' && candidate.length > 0) return candidate
  try {
    return JSON.stringify(errorJson, null, 2)
  } catch {
    return null
  }
}

export function isActionableSuggestion(
  currentWorkflow: unknown,
  suggestion: PatchSuggestion,
  selected: SuggestionTab,
): boolean {
  if (suggestion.mode !== 'ai') return false
  const diff = computeWorkflowDiff(toWorkflow(currentWorkflow), toWorkflow(selected.workflow))
  return diff.summary.totalChanges > 0
}

export function toWorkflow(value: unknown): WorkflowDefinition {
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
export function normalisePatchSuggestion(raw: PatchSuggestion): PatchSuggestion {
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
