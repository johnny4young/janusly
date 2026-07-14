import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSecret, listSecretRefs, signResumeToken, verifyResumeToken } from './secrets'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('secrets', () => {
  it('getSecret returns the env variable when present', () => {
    vi.stubEnv('MY_SECRET', 'abc123')
    expect(getSecret('MY_SECRET')).toBe('abc123')
  })

  it('getSecret throws when the env variable is missing', () => {
    expect(() => getSecret('UNDEFINED_FOR_TEST_LOL')).toThrow('Missing secret')
  })

  it('listSecretRefs detects references in strings, arrays, and objects', () => {
    const refs = listSecretRefs({
      url: 'https://api.example.com',
      headers: ['{{secret.SLACK_TOKEN}}', { auth: '{{secret.api_key}}' }],
    })
    expect(refs.sort()).toEqual(['SLACK_TOKEN', 'api_key'].sort())
  })

})

describe('signResumeToken / verifyResumeToken', () => {
  const expected = { orgId: 'org-a', runId: 'run-1', nodeId: 'collect', purpose: 'human_form' as const }

  function signLegacyToken(issuedAt: number): string {
    const payload = Buffer.from(JSON.stringify({ ...expected, issuedAt })).toString('base64url')
    const secret = process.env.JANUSLY_RESUME_TOKEN_SECRET || 'janusly-dev-resume-token-secret'
    const signature = createHmac('sha256', secret)
      .update(`v1.${payload}`)
      .digest('base64url')
    return `v1.${payload}.${signature}`
  }

  it('round-trips a token signed with the matching (orgId, runId, nodeId, purpose)', () => {
    const token = signResumeToken(expected)
    const payload = verifyResumeToken(token, expected)
    expect(payload.orgId).toBe('org-a')
    expect(payload.runId).toBe('run-1')
    expect(payload.nodeId).toBe('collect')
    expect(payload.purpose).toBe('human_form')
    expect(typeof payload.issuedAt).toBe('number')
    expect(payload.expiresAt! - payload.issuedAt).toBe(7 * 24 * 60 * 60)
  })

  it('rejects a token signed for a different org (cross-tenant binding)', () => {
    const token = signResumeToken({ ...expected, orgId: 'attacker-org' })
    expect(() => verifyResumeToken(token, expected)).toThrow('Invalid resume token')
  })

  it('rejects a token signed for a different run', () => {
    const token = signResumeToken({ ...expected, runId: 'other-run' })
    expect(() => verifyResumeToken(token, expected)).toThrow('Invalid resume token')
  })

  it('rejects a tampered signature', () => {
    const token = signResumeToken(expected)
    const tampered = `${token.slice(0, -3)}AAA`
    expect(() => verifyResumeToken(tampered, expected)).toThrow('Invalid resume token')
  })

  it('rejects an expired token after the TTL elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = signResumeToken(expected)
    // TTL is 7 days; jump 8 days forward and verify rejection.
    vi.setSystemTime(new Date('2026-01-09T00:00:00Z'))
    expect(() => verifyResumeToken(token, expected)).toThrow('Invalid resume token')
  })

  it('accepts a token within the TTL window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = signResumeToken(expected)
    // 6 days, well within the 7-day window.
    vi.setSystemTime(new Date('2026-01-07T00:00:00Z'))
    expect(() => verifyResumeToken(token, expected)).not.toThrow()
  })

  it('keeps legacy tokens without expiresAt valid for the original seven-day window', () => {
    vi.useFakeTimers()
    const issuedAt = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000)
    const legacy = signLegacyToken(issuedAt)

    vi.setSystemTime(new Date('2026-01-08T00:00:00Z'))
    expect(verifyResumeToken(legacy, expected).expiresAt).toBeUndefined()

    vi.setSystemTime(new Date('2026-01-08T00:00:01Z'))
    expect(() => verifyResumeToken(legacy, expected)).toThrow('Invalid resume token')
  })

  it('rejects a signed payload with a malformed explicit expiry instead of treating it as legacy', () => {
    const issuedAt = Math.floor(Date.now() / 1000)
    const payload = Buffer.from(JSON.stringify({ ...expected, issuedAt, expiresAt: null })).toString('base64url')
    const secret = process.env.JANUSLY_RESUME_TOKEN_SECRET || 'janusly-dev-resume-token-secret'
    const signature = createHmac('sha256', secret)
      .update(`v1.${payload}`)
      .digest('base64url')

    expect(() => verifyResumeToken(`v1.${payload}.${signature}`, expected)).toThrow('Invalid resume token')
  })

  it('uses a shorter signed per-token TTL when supplied', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = signResumeToken(expected, { ttlSeconds: 300 })
    const payload = verifyResumeToken(token, expected)
    expect(payload.expiresAt! - payload.issuedAt).toBe(300)

    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'))
    expect(() => verifyResumeToken(token, expected)).toThrow('Invalid resume token')
  })

  it('rejects invalid TTLs before signing', () => {
    expect(() => signResumeToken(expected, { ttlSeconds: 299 })).toThrow('Invalid resume token TTL')
    expect(() => signResumeToken(expected, { ttlSeconds: 7 * 24 * 60 * 60 + 1 })).toThrow('Invalid resume token TTL')
  })
})
