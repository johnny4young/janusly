import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSecret, listSecretRefs, maskSecrets } from './secrets'

afterEach(() => {
  vi.unstubAllEnvs()
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

  it('maskSecrets preserves placeholders without leaking values', () => {
    const masked = maskSecrets({ token: '{{secret.SECRET}}', plain: 'no secret here' })
    expect(masked).toEqual({ token: '{{secret.SECRET}}', plain: 'no secret here' })
  })
})
