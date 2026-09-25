import { describe, expect, it } from 'vitest'

import { parseRecoveryPatchSuggestion, parseRecoveryPlaybookUseResponse } from './recovery-patch-contract'

const workflow = {
  dslVersion: '1.0' as const,
  nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://api.example.com' } }],
  edges: [],
}

const passport = {
  failureSignature: 'Network timeout on http node',
  priorSameSignatureOutcome: null,
}

const tab = {
  workflow,
  rationale: 'Add a bounded retry.',
  approachLabel: 'add_retry',
  confidence: 84,
  calibratedConfidence: 79,
  safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
  consideredAlternatives: [{ approach: 'Raise timeout', rejectedBecause: 'The failure is a reset.' }],
}

const currentResponse = {
  mode: 'ai',
  suggestedWorkflow: workflow,
  rationale: 'Add a bounded retry.',
  suggestions: [tab],
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

const playbookUse = (patch: Record<string, unknown> = {}) => ({
  suggestion: {
    ...currentResponse,
    mode: 'playbook',
    suggestions: [{ ...tab, confidence: 100, calibratedConfidence: 100 }],
    playbook,
    ...patch,
  },
})

describe('parseRecoveryPatchSuggestion', () => {
  it('validates, scrubs and binds a current response to the persisted workflow', () => {
    const result = parseRecoveryPatchSuggestion(currentResponse, options)

    expect(result).not.toBeNull()
    expect(result?.suggestions[0]?.workflow.id).toBe('wf-1')
    expect(result?.evidence?.[0]?.snippet).toBe('Saw [redacted] in the old error')
  })

  it('leaves rationale lengths, confidence ranges and alternative counts to the server', () => {
    const long = {
      ...tab,
      rationale: 'x'.repeat(5_000),
      confidence: 140,
      calibratedConfidence: 140,
      consideredAlternatives: Array.from({ length: 4 }, () => ({ approach: 'a'.repeat(200), rejectedBecause: 'b' })),
    }
    const suggestions = Array.from({ length: 4 }, () => long)
    expect(parseRecoveryPatchSuggestion({ ...currentResponse, suggestions, aiError: 'e'.repeat(900) }, options)?.suggestions).toHaveLength(4)
  })

  it.each([
    ['a legacy envelope without suggestions', (() => {
      const { suggestions: _suggestions, ...legacy } = currentResponse
      return legacy
    })()],
    ['a missing recovery passport', (() => {
      const { recoveryPassport: _passport, ...withoutPassport } = currentResponse
      return withoutPassport
    })()],
    ['feedback health the dialog does not render', { ...currentResponse, feedbackHealth: {} }],
    ['a playbook mode on the patch route', { ...currentResponse, mode: 'playbook' }],
  ])('delegates shape to the generated guard: %s', (_name, payload) => {
    expect(parseRecoveryPatchSuggestion(payload, options)).toBeNull()
  })

  it.each([
    ['an empty suggestions list', { ...currentResponse, suggestions: [] }],
    ['an invalid suggested workflow', {
      ...currentResponse,
      suggestions: [{ ...tab, workflow: { ...workflow, edges: [{ from: 'x', to: 'y' }] } }],
    }],
    ['an approach the dialog cannot label', {
      ...currentResponse,
      suggestions: [{ ...tab, approachLabel: 'rewrite_everything' }],
    }],
    ['a misleading fallback calibration', {
      ...currentResponse,
      mode: 'fallback',
      suggestions: [{ ...tab, confidence: 0, calibratedConfidence: 100 }],
    }],
    ['an invalid evidence list', {
      ...currentResponse,
      evidence: [{ kind: 'recent_error', sourceRef: 'run-1', snippet: 'x', weight: 2 }],
    }],
    ['a mismatched recovery passport', {
      ...currentResponse,
      recoveryPassport: { ...passport, failureSignature: 'Other failure' },
    }],
    ['an explicitly foreign workflow identity', {
      ...currentResponse,
      suggestions: [{ ...tab, workflow: { ...workflow, id: 'wf-other' } }],
    }],
  ])('fails closed for %s', (_name, payload) => {
    expect(parseRecoveryPatchSuggestion(payload, options)).toBeNull()
  })

  it('never binds a patch response to a playbook the operator picked', () => {
    expect(parseRecoveryPatchSuggestion(currentResponse, { ...options, expectedPlaybookId: 'pb-1' })).toBeNull()
  })
})

describe('parseRecoveryPlaybookUseResponse', () => {
  it('requires the playbook identity and source metadata to match the requested recovery', () => {
    const request = { ...options, expectedPlaybookId: 'pb-1' }
    expect(parseRecoveryPlaybookUseResponse(playbookUse(), request)?.playbook).toEqual({
      id: 'pb-1',
      version: 2,
      title: 'Retry transient resets',
      successfulUses: 3,
      regressions: 0,
    })
    expect(parseRecoveryPlaybookUseResponse(playbookUse(), { ...request, expectedPlaybookId: 'pb-other' })).toBeNull()
    for (const source of [
      { ...playbook, status: 'retired' },
      { ...playbook, workflowId: 'wf-other' },
      { ...playbook, signature: 'Other failure' },
    ]) {
      expect(parseRecoveryPlaybookUseResponse(playbookUse({ playbook: source }), request)).toBeNull()
    }
  })

  it('pins a replayed playbook to one full-confidence suggestion', () => {
    const request = { ...options, expectedPlaybookId: 'pb-1' }
    const second = { ...tab, confidence: 100, calibratedConfidence: 100 }
    expect(parseRecoveryPlaybookUseResponse(playbookUse({ suggestions: [second, second] }), request)).toBeNull()
    expect(parseRecoveryPlaybookUseResponse(playbookUse({ suggestions: [{ ...second, confidence: 90 }] }), request)).toBeNull()
  })

  it('delegates the envelope shape to the generated guard', () => {
    expect(parseRecoveryPlaybookUseResponse(playbookUse().suggestion, options)).toBeNull()
    expect(parseRecoveryPlaybookUseResponse(playbookUse({ mode: 'ai' }), options)).toBeNull()
  })
})
