import { describe, expect, it } from 'vitest'
import {
  classifyRecoveryError,
  isActionableSuggestion,
  normalizeConsideredAlternatives,
  normalisePatchSuggestion,
  pickErrorMessage,
  pickFailedNodeErrorJson,
  resolveConfidenceDisplay,
  toWorkflow,
} from './recovery-dialog-model'
import type { PatchSuggestion, SuggestionTab } from './types'

const baseWorkflow = {
  dslVersion: '1.0' as const,
  nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x' } }],
  edges: [],
}

describe('normalizeConsideredAlternatives', () => {
  it('rejects malformed runtime values and returns at most two scrubbed bounded rows', () => {
    const secret = `sk-${'a'.repeat(20)}`
    expect(normalizeConsideredAlternatives('bad')).toEqual([])
    expect(normalizeConsideredAlternatives([null, [], { approach: 'missing reason' }])).toEqual([])

    const rows = normalizeConsideredAlternatives([
      { approach: `Raise\ntimeout ${secret}`, rejectedBecause: `Could hide\u202ean auth issue. ${'x'.repeat(400)}` },
      { approach: 'Swap provider', rejectedBecause: 'No approved provider is configured.' },
      { approach: 'Ignored third', rejectedBecause: 'Only two rows are allowed.' },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]?.approach).toBe('Raise timeout [redacted]')
    expect(rows[0]?.rejectedBecause).not.toContain('\u202e')
    expect(rows[0]?.rejectedBecause.length).toBe(280)
    expect(rows[1]?.approach).toBe('Swap provider')
  })

  it('scrubs extended secret families before rendering model-authored alternatives', () => {
    const privateKey = '-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----'
    expect(normalizeConsideredAlternatives([{
      approach: `Query redis://operator:password@cache.internal/0 with sk-ant-${'a'.repeat(24)}`,
      rejectedBecause: `Would expose ${privateKey}`,
    }])).toEqual([{
      approach: 'Query [redacted] with [redacted]',
      rejectedBecause: 'Would expose [redacted]',
    }])
  })
})

function suggestion(overrides: Partial<PatchSuggestion> = {}): PatchSuggestion {
  return {
    mode: 'ai',
    suggestedWorkflow: baseWorkflow,
    rationale: 'r',
    suggestions: [
      { workflow: baseWorkflow, rationale: 'r', approachLabel: 'other', confidence: 50 },
    ],
    ...overrides,
  }
}

describe('isActionableSuggestion', () => {
  it('returns false for a fallback-mode suggestion', () => {
    const selected = suggestion().suggestions[0]!
    expect(isActionableSuggestion(baseWorkflow, suggestion({ mode: 'fallback' }), selected)).toBe(false)
  })

  it('returns false when the AI suggestion is structurally identical to the current workflow', () => {
    const selected: SuggestionTab = { workflow: baseWorkflow, rationale: 'r', approachLabel: 'other', confidence: 50 }
    expect(isActionableSuggestion(baseWorkflow, suggestion(), selected)).toBe(false)
  })

  it('returns true when the AI suggestion diffs from the current workflow', () => {
    const patched = {
      dslVersion: '1.0' as const,
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x', retry: { maxAttempts: 3 } } }],
      edges: [],
    }
    const selected: SuggestionTab = { workflow: patched, rationale: 'r', approachLabel: 'add_retry', confidence: 80 }
    expect(isActionableSuggestion(baseWorkflow, suggestion(), selected)).toBe(true)
  })
})

describe('pickErrorMessage', () => {
  it('extracts a string `message` field', () => {
    expect(pickErrorMessage({ message: 'still 502 after retry' })).toBe('still 502 after retry')
  })

  it('returns null for non-object input', () => {
    expect(pickErrorMessage(null)).toBeNull()
    expect(pickErrorMessage('boom')).toBeNull()
  })

  it('falls back to a JSON dump when there is no string message', () => {
    expect(pickErrorMessage({ code: 502 })).toBe(JSON.stringify({ code: 502 }, null, 2))
  })
})

describe('pickFailedNodeErrorJson', () => {
  it('prefers the originally-failing node error', () => {
    const nodes = [
      { nodeId: 'other', status: 'failed', errorJson: { message: 'downstream' } },
      { nodeId: 'fetch', status: 'failed', errorJson: { message: 'target' } },
    ]
    expect(pickFailedNodeErrorJson(nodes, 'fetch')).toEqual({ message: 'target' })
  })

  it('falls back to any failed node when the focus node did not fail', () => {
    const nodes = [{ nodeId: 'other', status: 'failed', errorJson: { message: 'downstream' } }]
    expect(pickFailedNodeErrorJson(nodes, 'fetch')).toEqual({ message: 'downstream' })
  })

  it('returns null when nodes is undefined', () => {
    expect(pickFailedNodeErrorJson(undefined, 'fetch')).toBeNull()
  })
})

describe('normalisePatchSuggestion', () => {
  it('passes through a response that already has a non-empty suggestions array', () => {
    const input = suggestion()
    expect(normalisePatchSuggestion(input)).toBe(input)
  })

  it('synthesizes a single "other" item from the legacy shape (ai mode → confidence 50)', () => {
    const legacy = {
      mode: 'ai',
      suggestedWorkflow: baseWorkflow,
      rationale: 'Legacy single-suggestion shape.',
    } as unknown as PatchSuggestion
    const result = normalisePatchSuggestion(legacy)
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({
      workflow: baseWorkflow,
      rationale: 'Legacy single-suggestion shape.',
      approachLabel: 'other',
      confidence: 50,
      calibratedConfidence: 50,
    })
  })

  it('synthesizes confidence 0 for a legacy fallback-mode response', () => {
    const legacy = {
      mode: 'fallback',
      suggestedWorkflow: baseWorkflow,
      rationale: 'AI unavailable.',
    } as unknown as PatchSuggestion
    const result = normalisePatchSuggestion(legacy)
    expect(result.suggestions[0]).toMatchObject({ confidence: 0, calibratedConfidence: 0 })
  })
})

describe('resolveConfidenceDisplay', () => {
  it('shows only the raw self-rating when no calibration is present', () => {
    const tab: SuggestionTab = { workflow: baseWorkflow, rationale: 'r', approachLabel: 'other', confidence: 72 }
    expect(resolveConfidenceDisplay(tab)).toEqual({ primary: 72, showSelfRated: false, selfRated: 72 })
  })

  it('surfaces the self-rating subtitle only when the gap reaches the threshold', () => {
    const near: SuggestionTab = { workflow: baseWorkflow, rationale: 'r', approachLabel: 'other', confidence: 80, calibratedConfidence: 75 }
    expect(resolveConfidenceDisplay(near).showSelfRated).toBe(false)
    const far: SuggestionTab = { workflow: baseWorkflow, rationale: 'r', approachLabel: 'other', confidence: 80, calibratedConfidence: 60 }
    expect(resolveConfidenceDisplay(far)).toEqual({ primary: 60, showSelfRated: true, selfRated: 80 })
  })
})

describe('toWorkflow', () => {
  it('passes object values through and falls back to an empty workflow otherwise', () => {
    expect(toWorkflow(baseWorkflow)).toBe(baseWorkflow)
    expect(toWorkflow(null)).toEqual({ dslVersion: '1.0', nodes: [], edges: [] })
  })
})

describe('classifyRecoveryError', () => {
  it('classifies by error code', () => {
    expect(classifyRecoveryError({ code: 'ECONNREFUSED' })).toBe('network')
    expect(classifyRecoveryError({ code: 'ETIMEDOUT' })).toBe('timeout')
  })
  it('classifies by HTTP status', () => {
    expect(classifyRecoveryError({ status: 401 })).toBe('auth')
    expect(classifyRecoveryError({ statusCode: 429 })).toBe('rateLimit')
    expect(classifyRecoveryError({ status: 404 })).toBe('notFound')
    expect(classifyRecoveryError({ status: 503 })).toBe('serverError')
  })
  it('classifies by message text', () => {
    expect(classifyRecoveryError({ message: 'getaddrinfo ENOTFOUND api.example.com' })).toBe('network')
    expect(classifyRecoveryError({ message: 'Request timed out after 30s' })).toBe('timeout')
    expect(classifyRecoveryError({ message: 'Invalid API key' })).toBe('auth')
  })
  it('returns null for unknown / non-object errors', () => {
    expect(classifyRecoveryError({ message: 'something odd happened' })).toBeNull()
    expect(classifyRecoveryError(null)).toBeNull()
    expect(classifyRecoveryError('boom')).toBeNull()
  })
})
