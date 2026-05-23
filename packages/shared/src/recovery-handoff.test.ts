import { describe, expect, it } from 'vitest'

import {
  HandoffRequestBodySchema,
  RECOVERY_HANDOFF_DESTINATIONS,
  SLACK_HANDOFF_COOLDOWN_SECONDS,
  buildHandoffIdempotencyKey,
  composeHandoffMessage,
  isSlackHandoffCoolingDown,
} from './recovery-handoff'

describe('HandoffRequestBodySchema', () => {
  it('exposes exactly 4 destinations', () => {
    expect(RECOVERY_HANDOFF_DESTINATIONS).toEqual(['slack', 'linear', 'github', 'webhook'])
  })

  it('accepts a minimal slack handoff (credential only)', () => {
    const parsed = HandoffRequestBodySchema.safeParse({
      destination: 'slack',
      credentialName: 'Ops Slack',
    })
    expect(parsed.success).toBe(true)
  })

  it('requires owner + repo for github destination', () => {
    expect(
      HandoffRequestBodySchema.safeParse({
        destination: 'github',
        credentialName: 'bot',
      }).success,
    ).toBe(false)
    expect(
      HandoffRequestBodySchema.safeParse({
        destination: 'github',
        credentialName: 'bot',
        owner: 'acme',
        repo: 'ops',
      }).success,
    ).toBe(true)
  })

  it('requires url for webhook + linear destinations', () => {
    expect(
      HandoffRequestBodySchema.safeParse({ destination: 'webhook', credentialName: 'sec' }).success,
    ).toBe(false)
    expect(
      HandoffRequestBodySchema.safeParse({ destination: 'linear', credentialName: 'sec' }).success,
    ).toBe(false)
    expect(
      HandoffRequestBodySchema.safeParse({
        destination: 'webhook',
        credentialName: 'sec',
        url: 'https://hooks.example.com/abc',
      }).success,
    ).toBe(true)
  })

  it('rejects unknown destinations and unknown keys (strict)', () => {
    expect(
      HandoffRequestBodySchema.safeParse({ destination: 'pagerduty', credentialName: 'pd' }).success,
    ).toBe(false)
    expect(
      HandoffRequestBodySchema.safeParse({
        destination: 'slack',
        credentialName: 'Ops Slack',
        extraField: 'nope',
      }).success,
    ).toBe(false)
  })
})

describe('buildHandoffIdempotencyKey', () => {
  it('is stable for a given (item, destination) pair', () => {
    expect(buildHandoffIdempotencyKey('ri_1', 'github')).toBe('ri_1:github')
    expect(buildHandoffIdempotencyKey('ri_1', 'slack')).toBe('ri_1:slack')
  })
})

describe('isSlackHandoffCoolingDown', () => {
  it('returns true when last dispatch is recent', () => {
    const recent = new Date(Date.now() - 60_000) // 1 min ago
    expect(isSlackHandoffCoolingDown(recent)).toBe(true)
  })

  it('returns false when last dispatch is past cooldown', () => {
    const old = new Date(Date.now() - (SLACK_HANDOFF_COOLDOWN_SECONDS + 60) * 1_000)
    expect(isSlackHandoffCoolingDown(old)).toBe(false)
  })

  it('respects custom cooldownSeconds parameter', () => {
    const recent = new Date(Date.now() - 30 * 1_000)
    expect(isSlackHandoffCoolingDown(recent, new Date(), 60)).toBe(true)
    expect(isSlackHandoffCoolingDown(recent, new Date(), 10)).toBe(false)
  })
})

describe('composeHandoffMessage', () => {
  it('renders subject + severity + status + owner in create mode', () => {
    const msg = composeHandoffMessage({
      recoveryItemId: 'ri_1',
      deadLetterId: 'dl_1',
      severity: 'p1',
      status: 'acknowledged',
      owner: 'alice',
      workflowName: 'payouts',
      errorSignature: 'Missing secret: STRIPE_KEY',
    })
    expect(msg.subject).toContain('P1')
    expect(msg.subject).toContain('payouts')
    expect(msg.markdown).toContain('- **Severity**: P1')
    expect(msg.markdown).toContain('- **Status**: acknowledged')
    expect(msg.markdown).toContain('- **Owner**: alice')
    expect(msg.markdown).toContain('Missing secret: STRIPE_KEY')
  })

  it('uses Update header in append (second-call) mode', () => {
    const msg = composeHandoffMessage({
      recoveryItemId: 'ri_1',
      deadLetterId: 'dl_1',
      severity: 'p2',
      status: 'in_progress',
      appendMode: true,
      dispatchCount: 3,
    })
    expect(msg.markdown).toContain('Recovery item update')
    expect(msg.markdown).toContain('dispatch #3')
    expect(msg.structured.appendMode).toBe(true)
    expect(msg.structured.dispatchCount).toBe(3)
  })

  it('scrubs secret-shaped values from error signature + comments', () => {
    // Secret regex requires `sk-` + 20+ chars to match.
    const msg = composeHandoffMessage({
      recoveryItemId: 'ri_1',
      deadLetterId: 'dl_1',
      severity: 'p3',
      status: 'open',
      errorSignature: 'Authorization: Bearer abcd1234efgh5678ijkl9012 oops',
      recentComments: [
        { authorUserId: 'dev', body: 'Token sk-abcdef0123456789ABCDEF pasted', createdAt: '2026-05-22T00:00:00Z' },
      ],
    })
    expect(msg.markdown).not.toContain('sk-abcdef0123456789ABCDEF')
    expect(msg.markdown).not.toContain('abcd1234efgh5678ijkl9012')
  })

  it('appends recovery-center link when provided', () => {
    const msg = composeHandoffMessage({
      recoveryItemId: 'ri_1',
      deadLetterId: 'dl_1',
      severity: 'p3',
      status: 'open',
      recoveryCenterUrl: 'https://app.janusly.com/operations',
    })
    expect(msg.markdown).toContain('[Open Recovery Center](https://app.janusly.com/operations)')
  })

  it('emits structured envelope with ISO timestamp + appendMode flag', () => {
    const msg = composeHandoffMessage({
      recoveryItemId: 'ri_1',
      deadLetterId: 'dl_1',
      severity: 'p3',
      status: 'open',
    })
    expect(msg.structured.recoveryItemId).toBe('ri_1')
    expect(msg.structured.appendMode).toBe(false)
    expect(msg.structured.dispatchCount).toBe(1)
    expect(new Date(msg.structured.dispatchedAtIso).toString()).not.toBe('Invalid Date')
  })
})
