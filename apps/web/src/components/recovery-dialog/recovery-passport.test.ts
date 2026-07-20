import { describe, expect, it } from 'vitest'
import { evaluateRecoveryPassport } from './recovery-passport'

describe('evaluateRecoveryPassport', () => {
  it('marks a sandbox-passed, evidenced read-side patch safe', () => {
    expect(evaluateRecoveryPassport({
      suggestionMode: 'ai',
      actionable: true,
      safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
      evidenceCount: 2,
      sandboxStatus: 'passed',
    })).toEqual({ verdict: 'safe_to_apply', reasons: ['sandbox_passed'] })
  })

  it('keeps a write-side patch in review after sandbox success', () => {
    expect(evaluateRecoveryPassport({
      suggestionMode: 'ai',
      actionable: true,
      safety: { writeSide: true, approvalRequired: true, approvalPresent: true },
      evidenceCount: 1,
      sandboxStatus: 'passed',
    })).toEqual({ verdict: 'needs_review', reasons: ['write_side_requires_review'] })
  })

  it('blocks fallback and failed-sandbox patches independently of confidence', () => {
    expect(evaluateRecoveryPassport({
      suggestionMode: 'fallback',
      actionable: false,
      safety: undefined,
      evidenceCount: 4,
      sandboxStatus: 'passed',
    }).verdict).toBe('unsafe')
    expect(evaluateRecoveryPassport({
      suggestionMode: 'ai',
      actionable: true,
      safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
      evidenceCount: 4,
      sandboxStatus: 'failed',
    })).toEqual({ verdict: 'unsafe', reasons: ['sandbox_failed'] })
  })

  it('names every unresolved deterministic review signal', () => {
    expect(evaluateRecoveryPassport({
      suggestionMode: 'ai',
      actionable: true,
      safety: { writeSide: true, approvalRequired: true, approvalPresent: false },
      evidenceCount: 0,
      sandboxStatus: 'not_run',
    })).toEqual({
      verdict: 'needs_review',
      reasons: ['sandbox_required', 'write_side_requires_review', 'approval_missing', 'evidence_missing'],
    })
  })
})
