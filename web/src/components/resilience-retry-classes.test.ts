/**
 * The selective-retry toggle logic, pinned. The engine treats an empty/absent
 * retryOn as "retry everything", so the editor must OMIT the key rather than
 * persist `[]` — and it must not discard hand-authored patterns outside its
 * closed set.
 */

import { describe, expect, it } from 'vitest'

import { readRetryOnClasses, RETRY_CLASSES, toggleRetryClass } from './resilience-retry-classes'

describe('resilience retry classes', () => {
  it('exposes exactly the four transient classes the engine classifier emits', () => {
    expect(RETRY_CLASSES.map((c) => c.key)).toEqual(['5xx', '429', 'timeout', 'network'])
  })

  it('reads only known class keys from a raw retryOn value', () => {
    expect([...readRetryOnClasses(['5xx', 'timeout', 'ECONNRESET'])]).toEqual(['5xx', 'timeout'])
    expect([...readRetryOnClasses(undefined)]).toEqual([])
    expect([...readRetryOnClasses('nonsense')]).toEqual([])
  })

  it('turning a class on adds its engine pattern string', () => {
    expect(toggleRetryClass(undefined, '5xx', true)).toEqual(['5xx'])
    expect(toggleRetryClass(['5xx'], '429', true)).toEqual(['5xx', '429'])
  })

  it('turning the LAST class off omits retryOn (undefined), not an empty array', () => {
    // `[]` reads to a human as "retry nothing" even though the engine treats it
    // as "retry everything" — omitting the key restores the honest default.
    expect(toggleRetryClass(['5xx'], '5xx', false)).toBeUndefined()
  })

  it('preserves hand-authored patterns outside the editor set when toggling', () => {
    // An Advanced-JSON author who wrote `4xx` or `ECONNRESET` must not have it
    // silently discarded by clicking a checkbox.
    expect(toggleRetryClass(['ECONNRESET', '5xx'], 'timeout', true)).toEqual(['ECONNRESET', '5xx', 'timeout'])
    expect(toggleRetryClass(['ECONNRESET', '5xx'], '5xx', false)).toEqual(['ECONNRESET'])
  })

  it('never duplicates a class already present', () => {
    expect(toggleRetryClass(['5xx'], '5xx', true)).toEqual(['5xx'])
  })

  it('toggling an unknown key just normalizes the existing array', () => {
    expect(toggleRetryClass(['5xx', '5xx'], 'bogus', true)).toEqual(['5xx'])
    expect(toggleRetryClass([], 'bogus', true)).toBeUndefined()
  })
})
