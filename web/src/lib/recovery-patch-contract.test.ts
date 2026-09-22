import { describe, expect, it } from 'vitest'

import { parseRecoveryPatchSuggestion } from './recovery-patch-contract'

const workflow = {
  dslVersion: '1.0' as const,
  nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com' } }],
  edges: [],
}

const passport = {
  failureSignature: 'Network timeout on http node',
  priorSameSignatureOutcome: null,
}

const currentResponse = {
  mode: 'ai',
  suggestedWorkflow: workflow,
  rationale: 'Add a bounded retry.',
  suggestions: [{
    workflow,
    rationale: 'Add a bounded retry.',
    approachLabel: 'add_retry',
    confidence: 84,
    calibratedConfidence: 79,
    safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
    consideredAlternatives: [{ approach: 'Raise timeout', rejectedBecause: 'The failure is a reset.' }],
  }],
  evidence: [{
    kind: 'recent_error',
    sourceRef: 'run-1',
    snippet: `Saw sk-${'a'.repeat(24)} in the old error`,
  }],
  recoveryPassport: passport,
}

const options = {
  persistedWorkflowId: 'wf-1',
  expectedFailureSignature: passport.failureSignature,
}

describe('parseRecoveryPatchSuggestion', () => {
  it('validates, scrubs and binds a current response to the persisted workflow', () => {
    const result = parseRecoveryPatchSuggestion(currentResponse, options)

    expect(result).not.toBeNull()
    expect(result?.suggestions[0]?.workflow.id).toBe('wf-1')
    expect(result?.evidence?.[0]?.snippet).toBe('Saw [redacted] in the old error')
  })

  it('uses the validated suggestion as the current source of truth without legacy mirrors', () => {
    const { suggestedWorkflow: _workflow, rationale: _rationale, ...withoutMirrors } = currentResponse
    expect(parseRecoveryPatchSuggestion(withoutMirrors, options)?.suggestions[0]).toEqual(
      expect.objectContaining({ approachLabel: 'add_retry', rationale: 'Add a bounded retry.' }),
    )
  })

  it('supports only the intentional legacy envelope when suggestions is absent', () => {
    expect(parseRecoveryPatchSuggestion({
      mode: 'ai',
      suggestedWorkflow: workflow,
      rationale: 'Legacy response.',
    }, options)?.suggestions).toEqual([expect.objectContaining({
      approachLabel: 'other',
      confidence: 50,
      calibratedConfidence: 50,
      rationale: 'Legacy response.',
    })])

    expect(parseRecoveryPatchSuggestion({
      mode: 'fallback',
      suggestedWorkflow: workflow,
      rationale: 'Provider unavailable.',
    }, options)?.suggestions[0]).toEqual(expect.objectContaining({
      confidence: 0,
      calibratedConfidence: 0,
    }))
  })

  it.each([
    ['an empty current suggestions list', { ...currentResponse, suggestions: [] }],
    ['a present but non-array suggestions field', { ...currentResponse, suggestions: undefined }],
    ['an invalid suggested workflow', {
      ...currentResponse,
      suggestions: [{ ...currentResponse.suggestions[0], workflow: { nodes: [], edges: [{ from: 'x', to: 'y' }] } }],
    }],
    ['an out-of-range confidence', {
      ...currentResponse,
      suggestions: [{ ...currentResponse.suggestions[0], confidence: 101 }],
    }],
    ['a misleading fallback calibration', {
      ...currentResponse,
      mode: 'fallback',
      suggestions: [{ ...currentResponse.suggestions[0], confidence: 0, calibratedConfidence: 100 }],
    }],
    ['an invalid evidence list', {
      ...currentResponse,
      evidence: [{ kind: 'recent_error', sourceRef: 'run-1', snippet: 'x', weight: 2 }],
    }],
    ['a missing recovery passport', (() => {
      const { recoveryPassport: _passport, ...withoutPassport } = currentResponse
      return withoutPassport
    })()],
    ['a mismatched recovery passport', {
      ...currentResponse,
      recoveryPassport: { ...passport, failureSignature: 'Other failure' },
    }],
    ['an explicitly foreign workflow identity', {
      ...currentResponse,
      suggestions: [{ ...currentResponse.suggestions[0], workflow: { ...workflow, id: 'wf-other' } }],
    }],
  ])('fails closed for %s', (_name, payload) => {
    expect(parseRecoveryPatchSuggestion(payload, options)).toBeNull()
  })

  it('requires the playbook identity and source metadata to match the requested recovery', () => {
    const playbook = {
      id: 'pb-1',
      workflowId: 'wf-1',
      signature: passport.failureSignature,
      version: 2,
      status: 'active',
      title: 'Retry transient resets',
      instructionsMarkdown: 'Revalidate this saved patch.',
      approachLabel: 'add_retry',
      successfulUses: 3,
      regressions: 0,
      lastValidatedAt: '2026-09-21T12:00:00.000Z',
      activatedAt: '2026-09-21T12:00:00.000Z',
      retiredAt: null,
      createdAt: '2026-09-20T12:00:00.000Z',
      updatedAt: '2026-09-21T12:00:00.000Z',
    }
    const response = {
      ...currentResponse,
      mode: 'playbook',
      suggestions: [{ ...currentResponse.suggestions[0], confidence: 100, calibratedConfidence: 100 }],
      playbook,
    }

    expect(parseRecoveryPatchSuggestion(response, {
      ...options,
      expectedPlaybookId: 'pb-1',
    })?.playbook).toEqual({
      id: 'pb-1',
      version: 2,
      title: 'Retry transient resets',
      successfulUses: 3,
      regressions: 0,
    })
    expect(parseRecoveryPatchSuggestion(response, {
      ...options,
      expectedPlaybookId: 'pb-other',
    })).toBeNull()
  })
})
