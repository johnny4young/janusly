import { afterEach, describe, expect, it } from 'vitest'

import { readBuildId } from './build-id'

describe('readBuildId', () => {
  afterEach(() => { delete document.documentElement.dataset.buildId })

  it('reads the ID attached to the current HTML shell', () => {
    document.documentElement.dataset.buildId = '7ad05092'
    expect(readBuildId()).toBe('7ad05092')
  })

  it('uses an honest development fallback when the shell has no stamp', () => {
    expect(readBuildId()).toBe('dev')
  })
})
