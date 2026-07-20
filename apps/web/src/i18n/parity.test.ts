/**
 * Cross-locale parity gate. Every key present in the canonical English
 * catalog must exist in every other supported locale, and vice versa.
 *
 * When this test fails, either:
 *   - You added a new key to one locale and forgot the other (most common),
 *   - You renamed a key and forgot to mirror the rename,
 *   - You added a new locale and the catalog isn't seeded yet.
 *
 * Reported diffs name the missing keys precisely so the fix is obvious.
 */

import { describe, expect, it } from 'vitest'
import en from './locales/en/common.json'
import es from './locales/es/common.json'
import { loadLocaleCatalog, SUPPORTED_LANGUAGES } from './resources'

function keysOf(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort()
}

function diff(a: string[], b: string[]): string[] {
  const setB = new Set(b)
  return a.filter(key => !setB.has(key))
}

describe('i18n parity', () => {
  it('every supported locale has a demand loader', async () => {
    for (const lng of SUPPORTED_LANGUAGES) {
      expect(await loadLocaleCatalog(lng), `catalog missing for ${lng}`).toBeDefined()
    }
  })

  it('en and es have the same set of keys', () => {
    const enKeys = keysOf(en)
    const esKeys = keysOf(es)
    const missingInEs = diff(enKeys, esKeys)
    const missingInEn = diff(esKeys, enKeys)
    if (missingInEs.length > 0) {
      throw new Error(`Keys present in en but missing in es:\n  ${missingInEs.join('\n  ')}`)
    }
    if (missingInEn.length > 0) {
      throw new Error(`Keys present in es but missing in en:\n  ${missingInEn.join('\n  ')}`)
    }
    expect(enKeys).toEqual(esKeys)
  })

  it('no key has an empty string as its translation', () => {
    for (const [lng, payload] of [['en', en], ['es', es]] as const) {
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        expect(typeof value, `${lng}:${key} must be a string`).toBe('string')
        expect((value as string).length, `${lng}:${key} cannot be empty`).toBeGreaterThan(0)
      }
    }
  })
})
