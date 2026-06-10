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

  it('round-trips a token signed with the matching (orgId, runId, nodeId, purpose)', () => {
    const token = signResumeToken(expected)
    const payload = verifyResumeToken(token, expected)
    expect(payload.orgId).toBe('org-a')
    expect(payload.runId).toBe('run-1')
    expect(payload.nodeId).toBe('collect')
    expect(payload.purpose).toBe('human_form')
    expect(typeof payload.issuedAt).toBe('number')
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
})
