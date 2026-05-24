import { describe, expect, it } from 'vitest'

import { composeAlertMessage } from './alert-message'

describe('composeAlertMessage', () => {
  it('renders subject with policy name and trigger', () => {
    const msg = composeAlertMessage({
      policyName: 'DLQ alarm',
      trigger: 'dlq.entry_created',
      triggerPayload: { runId: 'run_1', nodeId: 'http-1' },
    })
    expect(msg.subject).toBe('[Janusly] DLQ alarm — dlq.entry_created')
    expect(msg.markdown).toContain('[Janusly] DLQ alarm')
    expect(msg.markdown).toContain('- **runId**: run_1')
    expect(msg.markdown).toContain('- **nodeId**: http-1')
  })

  it('appends a recovery link when provided', () => {
    const msg = composeAlertMessage({
      policyName: 'DLQ alarm',
      trigger: 'dlq.entry_created',
      triggerPayload: {},
      recoveryCenterUrl: 'https://app.janusly.com/operations',
    })
    expect(msg.markdown).toContain('[Open Recovery Center](https://app.janusly.com/operations)')
  })

  it('renders empty payload section gracefully', () => {
    const msg = composeAlertMessage({
      policyName: 'p',
      trigger: 'limiter.degraded',
      triggerPayload: {},
    })
    expect(msg.markdown).toContain('_(no additional context)_')
  })

  it('scrubs sk-* secrets from string payload fields', () => {
    const msg = composeAlertMessage({
      policyName: 'p',
      trigger: 'dlq.entry_created',
      triggerPayload: { message: 'Authorization: Bearer sk-abc1234567890abcdef oops' },
    })
    expect(msg.markdown).not.toContain('sk-abc1234567890')
    expect(msg.structured.payload.message).not.toContain('sk-abc1234567890')
  })

  it('scrubs nested secret-shaped values from structured webhook payloads', () => {
    const msg = composeAlertMessage({
      policyName: 'p',
      trigger: 'dlq.entry_created',
      triggerPayload: {
        nested: {
          headers: ['Authorization: Bearer sk-abc1234567890abcdef'],
        },
      },
    })
    expect(JSON.stringify(msg.structured.payload)).not.toContain('sk-abc1234567890')
    expect(msg.markdown).not.toContain('sk-abc1234567890')
  })

  it('caps oversized string values', () => {
    const huge = 'A'.repeat(1000)
    const msg = composeAlertMessage({
      policyName: 'p',
      trigger: 'dlq.entry_created',
      triggerPayload: { blob: huge },
    })
    expect(msg.markdown).toContain('…')
    expect(msg.markdown).not.toContain('A'.repeat(800))
  })

  it('handles null / undefined / boolean / number values', () => {
    const msg = composeAlertMessage({
      policyName: 'p',
      trigger: 'dlq.entry_created',
      triggerPayload: { a: null, b: undefined, c: true, d: 42 },
    })
    expect(msg.markdown).toContain('- **a**: —')
    expect(msg.markdown).toContain('- **b**: —')
    expect(msg.markdown).toContain('- **c**: true')
    expect(msg.markdown).toContain('- **d**: 42')
  })

  it('emits a structured envelope with ISO timestamp', () => {
    const msg = composeAlertMessage({
      policyName: 'p',
      trigger: 'budget.blocked',
      triggerPayload: { scope: 'org' },
    })
    expect(msg.structured.policyName).toBe('p')
    expect(msg.structured.trigger).toBe('budget.blocked')
    expect(msg.structured.payload).toEqual({ scope: 'org' })
    expect(msg.structured.recoveryCenterUrl).toBeNull()
    expect(new Date(msg.structured.dispatchedAtIso).toString()).not.toBe('Invalid Date')
  })
})
