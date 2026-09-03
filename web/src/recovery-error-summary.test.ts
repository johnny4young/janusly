import { describe, expect, it } from 'vitest'

import { buildRecoveryErrorSummary } from './recovery-error-summary'

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
