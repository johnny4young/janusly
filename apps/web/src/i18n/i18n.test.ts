/**
 * Unit tests for the i18n module proper: t() lookup, interpolation,
 * 'system' resolution, and the missing-key fallback path.
 */

import { describe, expect, beforeAll, it } from 'vitest'
import { initI18n } from './init'
import { t } from './runtime'
import { resolveSystemLocale } from './resolve'
import { changeAppLanguage, resolveAppLanguage } from './index'

beforeAll(() => {
  initI18n('en')
})

describe('i18n.t', () => {
  it('returns the English string for a known key', () => {
    expect(t('common.save')).toBe('Save')
  })

  it('returns the Spanish string after switching locale', () => {
    changeAppLanguage('es')
    expect(t('common.save')).toBe('Guardar')
    changeAppLanguage('en') // restore
  })

  it('interpolates {{var}} placeholders', () => {
    changeAppLanguage('en')
    expect(t('toasts.savedVersion', { version: 7 })).toBe('Saved version 7')
  })

  it('falls back to the missing-key sentinel behavior', () => {
    // i18next's default behavior is to return the key when nothing matches.
    expect(t('this.key.does.not.exist' as never)).toBe('this.key.does.not.exist')
  })
})

describe('resolveSystemLocale', () => {
  it("matches a Spanish navigator language", () => {
    expect(resolveSystemLocale(['es-MX', 'en-US'])).toBe('es')
  })

  it("matches an English navigator language", () => {
    expect(resolveSystemLocale(['en-GB'])).toBe('en')
  })

  it('falls back to en when no supported language is present', () => {
    expect(resolveSystemLocale(['fr-FR', 'de-DE'])).toBe('en')
  })

  it('falls back to en on empty / null input', () => {
    expect(resolveSystemLocale([])).toBe('en')
    expect(resolveSystemLocale(null)).toBe('en')
    expect(resolveSystemLocale(undefined)).toBe('en')
  })
})

describe('resolveAppLanguage', () => {
  it("returns the explicit choice unchanged for 'en' and 'es'", () => {
    expect(resolveAppLanguage('en')).toBe('en')
    expect(resolveAppLanguage('es')).toBe('es')
  })

  it("resolves 'system' against navigator.languages", () => {
    // jsdom default navigator.language is 'en-US' — should resolve to 'en'.
    const resolved = resolveAppLanguage('system')
    expect(['en', 'es']).toContain(resolved)
  })
})
