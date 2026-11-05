import { describe, expect, it } from 'vitest'
import {
  classifyRecoveryError,
  isActionableSuggestion,
  normalizeConsideredAlternatives,
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
  it.each([
    // Go transport failures.
    ['connection refused', { message: 'Post "https://api.example.com/v1": dial tcp 10.0.0.1:443: connect: connection refused' }, 'network'],
    ['connection reset', { message: 'read tcp 10.0.0.2:5000->10.0.0.1:443: read: connection reset by peer' }, 'network'],
    ['broken pipe', { message: 'write tcp 10.0.0.2:5000->10.0.0.1:443: write: broken pipe' }, 'network'],
    ['no route to host', { message: 'connect: no route to host' }, 'network'],
    ['network unreachable', { message: 'connect: network is unreachable' }, 'network'],
    ['transport EOF', { message: 'Post "https://api.example.com/v1": EOF' }, 'network'],
    ['wrapped mcp transport failure', { message: 'mcp_tool failed: dial tcp 10.0.0.1:443: connect: connection refused' }, 'network'],
    // Go resolver failures.
    ['no such host', { message: 'Get "https://demo.invalid/": dial tcp: lookup demo.invalid: no such host' }, 'network'],
    ['server misbehaving', { message: 'lookup demo.invalid on 127.0.0.11:53: server misbehaving' }, 'network'],
    ['empty resolver answer', { message: 'HTTP target did not resolve to any address: demo.invalid' }, 'network'],
    // Node codes and wording of the same class.
    ['EHOSTUNREACH code', { code: 'EHOSTUNREACH' }, 'network'],
    ['UND_ERR_SOCKET code', { code: 'UND_ERR_SOCKET' }, 'network'],
    ['fetch failed', { message: 'fetch failed' }, 'network'],
    ['socket hang up', { message: 'socket hang up' }, 'network'],
    ['dns wording', { message: 'DNS error' }, 'network'],
    // Timeouts.
    ['deadline exceeded', { message: 'context deadline exceeded' }, 'timeout'],
    ['dial timeout', { message: 'dial tcp 10.0.0.1:443: i/o timeout' }, 'timeout'],
    ['TLS handshake timeout', { message: 'net/http: TLS handshake timeout' }, 'timeout'],
    ['undici headers timeout code', { code: 'UND_ERR_HEADERS_TIMEOUT' }, 'timeout'],
    // A status means the peer answered.
    ['401 quoting a transport fault', { statusCode: 401, message: 'connection refused' }, 'auth'],
    ['404 with network wording', { statusCode: 404, message: 'network not found' }, 'notFound'],
    ['502 quoting a transport fault', { statusCode: 502, message: 'dial tcp 10.0.0.1:443: connect: connection refused' }, 'serverError'],
    ['503 with timeout wording', { statusCode: 503, message: 'upstream timeout' }, 'serverError'],
    ['400 quoting a transport fault', { statusCode: 400, message: 'upstream said connection refused' }, null],
    // Permanent failures must not read as transient.
    ['ssrf private target', { message: 'HTTP target is private and blocked: 10.0.0.1' }, null],
    ['unvalidated dial', { message: 'refusing to dial unvalidated host: example.com' }, null],
    ['certificate failure', { message: 'Get "https://example.com/": tls: failed to verify certificate: x509: certificate signed by unknown authority' }, null],
    ['cancelled', { message: 'Get "https://example.com/": context canceled' }, null],
    ['decoder EOF', { message: 'unexpected EOF' }, null],
    ['host name containing dns', { message: 'tls: bad certificate from dnsimple.example' }, null],
  ])('classifies the failure matrix: %s', (_name, errorJson, want) => {
    expect(classifyRecoveryError(errorJson)).toBe(want)
  })
  it('returns null for unknown / non-object errors', () => {
    expect(classifyRecoveryError({ message: 'something odd happened' })).toBeNull()
    expect(classifyRecoveryError(null)).toBeNull()
    expect(classifyRecoveryError('boom')).toBeNull()
  })
})
