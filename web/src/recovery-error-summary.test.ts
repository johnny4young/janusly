import { describe, expect, it } from 'vitest'

import { buildRecoveryErrorSummary, describeRecoveryError } from './recovery-error-summary'

const fallbacks = {
  workflow: 'Unnamed workflow',
  nodeType: 'unknown type',
  error: 'Unknown error',
  timestamp: 'Unknown time',
}

describe('buildRecoveryErrorSummary', () => {
  it('builds the paste-ready workflow, node, error, timestamp, and run line', () => {
    expect(buildRecoveryErrorSummary({
      workflowName: 'Refund triage',
      nodeId: 'charge-card',
      nodeType: 'http',
      errorJson: { message: 'HTTP 503 from billing' },
      createdAt: '2026-07-13T12:34:56-05:00',
      runId: 'run-123',
    }, fallbacks)).toBe(
      'Refund triage · charge-card (http) · HTTP 503 from billing · 2026-07-13T17:34:56.000Z · run-123',
    )
  })

  it('finds a nested error message and uses localized fallbacks for missing metadata', () => {
    expect(buildRecoveryErrorSummary({
      nodeId: 'notify',
      errorJson: { error: { reason: 'Webhook timed out' } },
      runId: 'run-456',
    }, fallbacks)).toBe(
      'Unnamed workflow · notify (unknown type) · Webhook timed out · Unknown time · run-456',
    )
  })

  it('collapses multiline metadata and messages into one paste-ready line', () => {
    expect(buildRecoveryErrorSummary({
      workflowName: 'Refund\ntriage',
      nodeId: 'notify',
      nodeType: 'webhook',
      errorJson: { message: 'First line\n  second line' },
      createdAt: '2026-07-13T12:00:00Z',
      runId: 'run-789',
    }, fallbacks)).toContain('Refund triage · notify (webhook) · First line second line')
  })
})

describe('describeRecoveryError', () => {
  const DEMO_DNS = 'Get "https://demo-ingest.invalid/feed": dial tcp: lookup demo-ingest.invalid: no such host'

  it.each([
    ['go dns failure', { message: DEMO_DNS }, 'demo-ingest.invalid', 'network_timeout', 'DNS', false],
    ['dns via resolver', { message: 'lookup api.example.com on 127.0.0.11:53: no such host' }, 'api.example.com', 'network_timeout', 'DNS', false],
    ['transient resolver', { message: 'lookup api.example.com: server misbehaving' }, 'api.example.com', 'network_timeout', 'DNS', true],
    ['dns without host', { message: 'DNS lookup failed: no such host' }, null, 'network_timeout', 'DNS', false],
    ['node dns code', { message: 'getaddrinfo ENOTFOUND api.example.com' }, 'api.example.com', 'network_timeout', 'DNS', false],
    ['http policy dns', { message: 'HTTP target did not resolve to any address: api.example.com' }, 'api.example.com', 'network_timeout', 'DNS', false],
    ['connection refused', { message: 'dial tcp 10.0.0.1:443: connect: connection refused' }, null, 'network_timeout', null, true],
    ['deadline', { message: 'Get "https://api.example.com/x": context deadline exceeded' }, null, 'network_timeout', null, true],
    ['node timeout code', { message: 'connect ETIMEDOUT 10.0.0.1:443' }, null, 'network_timeout', null, true],
    ['timed out', { message: 'node timed out' }, null, 'network_timeout', null, true],
    ['server error', { message: 'boom', statusCode: 503 }, null, 'http_error', 503, true],
    ['client error', { message: 'HTTP 404 from upstream' }, null, 'http_error', 404, false],
    ['throttled', { message: 'boom', statusCode: 429 }, null, 'http_error', 429, true],
    ['platform limiter', { message: 'Rate limit exceeded for llm. Retry in 30s.' }, null, 'http_error', null, true],
    ['policy limit', { message: 'HTTP response exceeds maxResponseBytes after 2048 bytes' }, null, 'http_error', null, false],
    ['missing secret', { code: 'E_SECRET_MISSING', secret: 'GITHUB_TOKEN' }, null, 'secret_missing', null, false],
    ['tool input', { message: 'Invalid tool input: github.create_issue' }, null, 'tool_input', null, false],
    ['parse', { message: 'Unexpected token < in JSON at position 0' }, null, 'parse_error', null, false],
  ])('%s', (_name, errorJson, dnsHost, category, causeDetail, retryable) => {
    expect(describeRecoveryError(errorJson, 'http')).toMatchObject({ dnsHost, category, causeDetail, retryable })
  })

  it('states a coded failure by its signature when it carries no message', () => {
    expect(describeRecoveryError({ code: 'E_SECRET_MISSING', secret: 'GITHUB_TOKEN' }).message).toBe('Missing secret: GITHUB_TOKEN')
  })

  it('only calls an AI failure retryable when the provider is rate limiting', () => {
    expect(describeRecoveryError({ message: 'rate limit exceeded', provider: 'anthropic' }, 'ai')).toMatchObject({
      category: 'ai_provider', retryable: true,
    })
    expect(describeRecoveryError({ message: 'quota exceeded', provider: 'openai' }, 'ai')).toMatchObject({
      category: 'ai_provider', retryable: false,
    })
  })

  it('never calls a write-side failure retryable', () => {
    expect(describeRecoveryError({ message: 'boom', statusCode: 503, writeSide: true }, 'http').retryable).toBe(false)
    expect(describeRecoveryError({ message: 'something odd', writeSide: true }).retryable).toBe(false)
  })

  it('makes no claim about an unclassified failure', () => {
    expect(describeRecoveryError({ message: 'something odd happened' })).toEqual({
      dnsHost: null,
      message: 'something odd happened',
      category: null,
      causeDetail: null,
      retryable: null,
    })
    expect(describeRecoveryError(null)).toMatchObject({ message: null, category: null, retryable: null })
    expect(describeRecoveryError({ code: 'worker_stalled', message: 'Node was left running' }, 'tool').retryable).toBeNull()
  })

  it('scrubs secret shapes from free-form messages', () => {
    const token = `ghp_${'a'.repeat(30)}`
    expect(describeRecoveryError({ message: `upstream echoed ${token} back` }).message).toBe('upstream echoed [redacted] back')
  })

  it('never surfaces a secret-shaped or malformed host', () => {
    expect(describeRecoveryError({ message: `lookup sk-${'a'.repeat(24)}: no such host` }).dnsHost).toBeNull()
    expect(describeRecoveryError({ message: 'lookup bad<host>: no such host' }).dnsHost).toBeNull()
    expect(describeRecoveryError({ message: 'DNS lookup of the target: no such host' }).dnsHost).toBeNull()
  })
})
