import { describe, expect, it } from 'vitest'
import { hasFailureSignal } from './failure-signal'

describe('hasFailureSignal', () => {
  it('detects structured errors and failed statuses', () => {
    expect(hasFailureSignal({ error: { message: 'boom' } })).toBe(true)
    expect(hasFailureSignal({ status: 'failed' })).toBe(true)
    expect(hasFailureSignal({ ok: false })).toBe(true)
  })

  it('does not treat ordinary API text as a failure', () => {
    expect(hasFailureSignal({
      value: 'GitHub returned current_user_url and repository_search_url fields.',
      errors_url: 'https://api.github.com/repos/octo/demo/errors{/sha}',
      status: 'succeeded',
      ok: true,
    })).toBe(false)
  })

  it('detects direct text failure signals', () => {
    expect(hasFailureSignal('Error: request failed')).toBe(true)
    expect(hasFailureSignal('status: failed')).toBe(true)
  })
})
