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

describe('composeAlertMessage — deep link to the failure', () => {
  const base = 'https://app.example.com/operations'

  it('links to the exact dead letter, not the generic queue', () => {
    // The MTTR clock starts at the alert; a link to a queue of 200 rows makes
    // the operator hunt for the one the page was about.
    const msg = composeAlertMessage({
      policyName: 'P1',
      trigger: 'dlq.entry_created',
      triggerPayload: { deadLetterId: 'dl-42', runId: 'run-1' },
      recoveryCenterUrl: base,
    })

    expect(msg.structured.deepLinkUrl).toBe(`${base}?deadLetterId=dl-42`)
    expect(msg.markdown).toContain(`${base}?deadLetterId=dl-42`)
    expect(msg.markdown).not.toContain('[Open Recovery Center]')
  })

  it('falls back to the plain Recovery Center link when no failure is identified', () => {
    // A tripped breaker is about the workflow, not one row — there is nothing
    // to point at, and a link that lands on the wrong failure is worse than
    // no link.
    const msg = composeAlertMessage({
      policyName: 'P1',
      trigger: 'workflow.circuit_breaker_tripped',
      triggerPayload: { workflowId: 'wf-1' },
      recoveryCenterUrl: base,
    })

    expect(msg.structured.deepLinkUrl).toBeNull()
    expect(msg.markdown).toContain('[Open Recovery Center]')
  })

  it('emits no link at all when the deployment has no public URL', () => {
    const msg = composeAlertMessage({
      policyName: 'P1',
      trigger: 'dlq.entry_created',
      triggerPayload: { deadLetterId: 'dl-42' },
    })

    expect(msg.structured.deepLinkUrl).toBeNull()
    expect(msg.markdown).not.toContain('http')
  })

  it('URL-encodes the id — it reaches outbound Slack/GitHub/email bodies', () => {
    const msg = composeAlertMessage({
      policyName: 'P1',
      trigger: 'dlq.entry_created',
      triggerPayload: { deadLetterId: 'dl 42&x=1' },
      recoveryCenterUrl: base,
    })

    expect(msg.structured.deepLinkUrl).toBe(`${base}?deadLetterId=dl%2042%26x%3D1`)
  })

  it('refuses a non-string or oversized id rather than building a junk link', () => {
    const bad = composeAlertMessage({
      policyName: 'P1', trigger: 'dlq.entry_created',
      triggerPayload: { deadLetterId: 12345 }, recoveryCenterUrl: base,
    })
    expect(bad.structured.deepLinkUrl).toBeNull()

    const huge = composeAlertMessage({
      policyName: 'P1', trigger: 'dlq.entry_created',
      triggerPayload: { deadLetterId: 'x'.repeat(257) }, recoveryCenterUrl: base,
    })
    expect(huge.structured.deepLinkUrl).toBeNull()
  })
})
