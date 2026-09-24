import { describe, expect, it } from 'vitest'

import { injectBuildStamp } from '../../scripts/build-stamp'

const html = '<!doctype html><html lang="en"><head></head><body></body></html>'

describe('HTML build stamp', () => {
  it('injects a safe per-build ID into the no-cache HTML shell', () => {
    expect(injectBuildStamp(html, '2026-09-23-7ad05092'))
      .toContain('<html lang="en" data-build-id="2026-09-23-7ad05092">')
  })

  it('rejects IDs that could escape the HTML attribute or break provenance', () => {
    expect(() => injectBuildStamp(html, 'abc" onload="alert(1)')).toThrow(/build ID/)
    expect(() => injectBuildStamp(html, '')).toThrow(/build ID/)
    expect(() => injectBuildStamp('<html><head></head></html>', '7ad05092')).toThrow(/HTML root/)
  })
})
