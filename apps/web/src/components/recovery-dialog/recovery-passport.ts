/**
 * Pure verdict logic for the Recovery Confidence Passport.
 *
 * The LLM confidence value is intentionally absent from this input: a model's
 * self-assessment is display-only evidence and can never turn an unsafe or
 * unvalidated patch into a safe one.
 */

import type { SuggestionTab } from './types'

export type RecoverySandboxStatus = 'not_run' | 'running' | 'passed' | 'failed'
export type RecoveryPassportVerdict = 'safe_to_apply' | 'needs_review' | 'unsafe'
export type RecoveryPassportReason =
  | 'suggestion_unavailable'
  | 'sandbox_required'
  | 'sandbox_running'
  | 'sandbox_failed'
  | 'write_side_requires_review'
  | 'approval_missing'
  | 'risk_unknown'
  | 'evidence_missing'
  | 'sandbox_passed'

export type RecoveryPassportEvaluation = {
  verdict: RecoveryPassportVerdict
  reasons: RecoveryPassportReason[]
}

export function evaluateRecoveryPassport(input: {
  suggestionMode: 'ai' | 'fallback' | 'playbook'
  actionable: boolean
  safety: SuggestionTab['safety']
  evidenceCount: number
  sandboxStatus: RecoverySandboxStatus
}): RecoveryPassportEvaluation {
  if (input.suggestionMode === 'fallback' || !input.actionable) {
    return { verdict: 'unsafe', reasons: ['suggestion_unavailable'] }
  }
  if (input.sandboxStatus === 'failed') {
    return { verdict: 'unsafe', reasons: ['sandbox_failed'] }
  }

  const reasons: RecoveryPassportReason[] = []
  if (input.sandboxStatus === 'not_run') reasons.push('sandbox_required')
  if (input.sandboxStatus === 'running') reasons.push('sandbox_running')
  if (!input.safety) {
    reasons.push('risk_unknown')
  } else if (input.safety.writeSide) {
    reasons.push('write_side_requires_review')
    if (input.safety.approvalRequired && !input.safety.approvalPresent) {
      reasons.push('approval_missing')
    }
  }
  if (input.evidenceCount === 0) reasons.push('evidence_missing')

  if (reasons.length > 0) return { verdict: 'needs_review', reasons }
  return { verdict: 'safe_to_apply', reasons: ['sandbox_passed'] }
}
