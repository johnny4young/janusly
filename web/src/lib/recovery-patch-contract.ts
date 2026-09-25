/** UI invariants for AI and Recovery Playbook patch responses; shape is the generated guards'. */

import type { ApiResponses } from './api-types.generated'
import { parseEvidenceRows } from './ai-evidence-runtime'
import { isWorkflowDefinition } from './authoring-contract'
import { isPostAiPatchWorkflowResponse } from './api-guards/operations/PostAiPatchWorkflow'
import { isPostRecoveryPlaybooksIdUseResponse } from './api-guards/operations/PostRecoveryPlaybooksIdUse'
import type { WorkflowDefinition } from '../types'
import type {
  PatchApproachLabel,
  PatchSuggestion,
  SuggestionTab,
} from '../components/recovery-dialog/types'

type WirePatch = ApiResponses['POST /ai/patch-workflow'] | ApiResponses['POST /recovery/playbooks/{id}/use']['suggestion']

const APPROACHES: readonly PatchApproachLabel[] = [
  'add_retry', 'raise_timeout', 'swap_secret_ref', 'add_approval', 'fix_url', 'other',
]

export type RecoveryPatchParseOptions = {
  persistedWorkflowId?: string | null
  expectedFailureSignature?: string | null
  expectedPlaybookId?: string | null
}

// Validation and save target the persisted workflow, never an id the model invented.
function workflow(value: unknown, id?: string | null): WorkflowDefinition | null {
  if (!isWorkflowDefinition(value) || (id && value.id !== undefined && value.id !== id)) return null
  return id && value.id !== id ? { ...value, id } : value
}

function tab(value: WirePatch['suggestions'][number], id?: string | null): SuggestionTab | null {
  const parsedWorkflow = workflow(value.workflow, id)
  // The suggestion tabs translate the approach label; an unknown one has no copy.
  if (!parsedWorkflow || !APPROACHES.includes(value.approachLabel as PatchApproachLabel)) return null
  return { ...value, approachLabel: value.approachLabel as PatchApproachLabel, workflow: parsedWorkflow }
}

function suggestion(value: WirePatch, options: RecoveryPatchParseOptions): PatchSuggestion | null {
  // The review step always opens on a first tab.
  if (value.suggestions.length === 0) return null
  const suggestions: SuggestionTab[] = []
  for (const item of value.suggestions) {
    const parsed = tab(item, options.persistedWorkflowId)
    if (!parsed) return null
    suggestions.push(parsed)
  }
  // The confidence badge must not claim model confidence for a fallback or a replayed playbook.
  // wire-policy: the patch route pins fallback to 0 and playbook replays to 100 confidence.
  const fixedConfidence = value.mode === 'fallback' ? 0 : value.mode === 'playbook' ? 100 : null
  if (fixedConfidence !== null && (value.mode === 'playbook' && suggestions.length !== 1
    || suggestions.some((item) => item.confidence !== fixedConfidence
      || (item.calibratedConfidence ?? fixedConfidence) !== fixedConfidence))) return null

  // The passport card describes the failure this dialog was opened for.
  const passport = value.recoveryPassport
  if (options.expectedFailureSignature && passport.failureSignature !== options.expectedFailureSignature) return null

  const evidence = parseEvidenceRows(value.evidence)
  if (!evidence) return null

  let playbook: PatchSuggestion['playbook']
  if (value.mode === 'playbook') {
    const source = value.playbook
    // Only the playbook the operator picked, for this workflow and failure, may replay.
    if (source.status !== 'active'
      || options.expectedPlaybookId && source.id !== options.expectedPlaybookId
      || options.persistedWorkflowId && source.workflowId !== options.persistedWorkflowId
      || options.expectedFailureSignature && source.signature !== options.expectedFailureSignature) return null
    playbook = {
      id: source.id, version: source.version, title: source.title,
      successfulUses: source.successfulUses, regressions: source.regressions,
    }
  } else if (options.expectedPlaybookId) return null

  return {
    mode: value.mode,
    suggestions,
    evidence,
    recoveryPassport: { failureSignature: passport.failureSignature, priorSameSignatureOutcome: null },
    ...(value.mode !== 'playbook' && typeof value.aiError === 'string' ? { aiError: value.aiError } : {}),
    ...(playbook ? { playbook } : {}),
  }
}

/** Parse a `POST /ai/patch-workflow` payload before it can enter dialog state. */
export function parseRecoveryPatchSuggestion(
  value: unknown,
  options: RecoveryPatchParseOptions = {},
): PatchSuggestion | null {
  return isPostAiPatchWorkflowResponse(value) ? suggestion(value, options) : null
}

export function parseRecoveryPlaybookUseResponse(
  value: unknown,
  options: RecoveryPatchParseOptions,
): PatchSuggestion | null {
  return isPostRecoveryPlaybooksIdUseResponse(value) ? suggestion(value.suggestion, options) : null
}
