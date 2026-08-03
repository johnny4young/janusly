import { describe, expect, it } from 'vitest'
import { expandCatalogKeys, materializeCatalog } from './compact-catalog'

describe('compact catalog', () => {
  it('expands front-coded keys and preserves value order', () => {
    expect(expandCatalogKeys(
      '@recovery.title\0Kmeline\0@settings.title',
    )).toEqual([
      'recovery.title',
      'recovery.timeline',
      'settings.title',
    ])

    expect(materializeCatalog(
      '@common.save\0Gcancel',
      ['Save', 'Cancel'],
    )).toEqual({
      'common.save': 'Save',
      'common.cancel': 'Cancel',
    })
  })

  it('rejects an impossible prefix and key/value length drift', () => {
    expect(() => expandCatalogKeys('Binvalid')).toThrow(
      'Locale catalog key projection is invalid',
    )
    expect(() => materializeCatalog('@common.save', [])).toThrow(
      'Locale catalog key/value projection is inconsistent',
    )
  })
})
