/** Runtime guard for untrusted AI and Recovery Playbook patch responses. */

import { parseEvidenceRows } from './ai-evidence-runtime'
import { isWorkflowDefinition } from './authoring-contract'
import { isNonEmptyString, isNonNegativeSafeInteger, isRecord } from './guards'
import type { WorkflowDefinition } from '../types'
import type {
  PatchApproachLabel,
  PatchSuggestion,
  PriorSameSignatureOutcome,
  SuggestionTab,
} from '../components/recovery-dialog/types'

const APPROACHES: readonly PatchApproachLabel[] = [
  'add_retry', 'raise_timeout', 'swap_secret_ref', 'add_approval', 'fix_url', 'other',
]

export type RecoveryPatchParseOptions = {
  persistedWorkflowId?: string | null
  expectedFailureSignature?: string | null
  expectedPlaybookId?: string | null
}

function text(value: unknown, max: number): value is string {
  return isNonEmptyString(value) && value.length <= max
}

function approach(value: unknown): value is PatchApproachLabel {
  return typeof value === 'string' && APPROACHES.includes(value as PatchApproachLabel)
}

function percent(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100
}

function workflow(value: unknown, id?: string | null): WorkflowDefinition | null {
  if (!isWorkflowDefinition(value) || (id && value.id !== undefined && value.id !== id)) return null
  return id && value.id !== id ? { ...value, id } : value
}

function tab(value: unknown, id?: string | null): SuggestionTab | null {
  if (!isRecord(value)) return null
  const parsedWorkflow = workflow(value.workflow, id)
  if (!parsedWorkflow || !text(value.rationale, 4_000) || !approach(value.approachLabel)
    || !percent(value.confidence)) return null
  if (value.calibratedConfidence !== undefined && !percent(value.calibratedConfidence)) return null
  if (value.safety !== undefined && (!isRecord(value.safety)
    || typeof value.safety.writeSide !== 'boolean'
    || typeof value.safety.approvalRequired !== 'boolean'
    || typeof value.safety.approvalPresent !== 'boolean')) return null
  if (value.consideredAlternatives !== undefined && (!Array.isArray(value.consideredAlternatives)
    || value.consideredAlternatives.length > 2
    || value.consideredAlternatives.some((item) => !isRecord(item)
      || !text(item.approach, 120) || !text(item.rejectedBecause, 280)))) return null
  return { ...value, workflow: parsedWorkflow } as SuggestionTab
}

function priorOutcome(value: unknown): PriorSameSignatureOutcome | null | undefined {
  if (value === null) return null
  return isRecord(value) && text(value.status, 64) && text(value.occurredAt, 64)
    ? { status: value.status, occurredAt: value.occurredAt }
    : undefined
}

function passport(
  value: unknown,
  expected?: string | null,
): PatchSuggestion['recoveryPassport'] | null {
  if (!isRecord(value) || !text(value.failureSignature, 512)
    || expected && value.failureSignature !== expected) return null
  const prior = priorOutcome(value.priorSameSignatureOutcome)
  return prior === undefined ? null : { failureSignature: value.failureSignature, priorSameSignatureOutcome: prior }
}

function playbook(value: unknown, options: RecoveryPatchParseOptions): PatchSuggestion['playbook'] | null {
  if (!isRecord(value) || !text(value.id, 256) || !text(value.signature, 512)
    || !text(value.title, 120) || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || value.status !== 'active' || !isNonNegativeSafeInteger(value.successfulUses)
    || !isNonNegativeSafeInteger(value.regressions)
    || options.expectedPlaybookId && value.id !== options.expectedPlaybookId
    || options.persistedWorkflowId && value.workflowId !== options.persistedWorkflowId
    || options.expectedFailureSignature && value.signature !== options.expectedFailureSignature) return null
  return {
    id: value.id,
    version: value.version as number,
    title: value.title,
    successfulUses: value.successfulUses,
    regressions: value.regressions,
  }
}
/**
 * Parse a patch response before it can enter dialog state. Only envelopes with
 * no `suggestions` property receive the intentional legacy projection; a
 * present malformed list fails closed.
 */
export function parseRecoveryPatchSuggestion(
  value: unknown,
  options: RecoveryPatchParseOptions = {},
): PatchSuggestion | null {
  if (!isRecord(value) || !['ai', 'fallback', 'playbook'].includes(String(value.mode))) return null
  const current = Object.hasOwn(value, 'suggestions')
  let suggestions: SuggestionTab[]
  if (!current) {
    const mirror = workflow(value.suggestedWorkflow, options.persistedWorkflowId)
    if (!mirror || !text(value.rationale, 4_000) || value.mode === 'playbook' || options.expectedPlaybookId) return null
    const confidence = value.mode === 'ai' ? 50 : 0
    suggestions = [{ workflow: mirror, rationale: value.rationale, approachLabel: 'other', confidence, calibratedConfidence: confidence }]
  } else {
    if (!Array.isArray(value.suggestions) || value.suggestions.length < 1 || value.suggestions.length > 3) return null
    suggestions = value.suggestions.map((item) => tab(item, options.persistedWorkflowId)) as SuggestionTab[]
    if (suggestions.some((item) => !item)) return null
  }
  const fixedConfidence = value.mode === 'fallback' ? 0 : value.mode === 'playbook' ? 100 : null
  if (fixedConfidence !== null && (value.mode === 'playbook' && suggestions.length !== 1
    || suggestions.some((item) => item.confidence !== fixedConfidence
      || (item.calibratedConfidence ?? fixedConfidence) !== fixedConfidence))) return null

  const parsedPassport = value.recoveryPassport === undefined
    ? null
    : passport(value.recoveryPassport, options.expectedFailureSignature)
  if (current && !parsedPassport || value.recoveryPassport !== undefined && !parsedPassport) return null

  const evidence = parseEvidenceRows(value.evidence ?? [])
  if (!evidence) return null

  if (value.feedbackHealth !== undefined) return null
  const parsedPlaybook = value.playbook === undefined ? undefined : playbook(value.playbook, options)
  if (value.mode === 'playbook' ? !parsedPlaybook : value.playbook !== undefined || options.expectedPlaybookId) return null
  if (value.aiError !== undefined && !text(value.aiError, 800)) return null

  return {
    mode: value.mode as PatchSuggestion['mode'],
    suggestions,
    evidence,
    ...(parsedPassport ? { recoveryPassport: parsedPassport } : {}),
    ...(typeof value.aiError === 'string' ? { aiError: value.aiError } : {}),
    ...(parsedPlaybook ? { playbook: parsedPlaybook } : {}),
  }
}

export function parseRecoveryPlaybookUseResponse(
  value: unknown,
  options: RecoveryPatchParseOptions,
): PatchSuggestion | null {
  return isRecord(value) ? parseRecoveryPatchSuggestion(value.suggestion, options) : null
}
