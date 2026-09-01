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

  it('keeps the Home Operator Brief copy in the eagerly available core catalog', () => {
    changeAppLanguage('en')
    expect(t('operations.brief.semanticCase.title'))
      .toBe('Diagnose a business outcome incident')
    changeAppLanguage('es')
    expect(t('operations.brief.semanticCase.title'))
      .toBe('Diagnosticar un incidente de resultado de negocio')
    changeAppLanguage('en')
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

  it('selects the active locale cardinal plural before interpolation', () => {
    changeAppLanguage('en')
    expect(t('snippets.menu.nodeCount', { count: 1 })).toBe('1 node')
    expect(t('snippets.menu.nodeCount', { count: 3 })).toBe('3 nodes')
  })

  it('uses an explicit default for dynamic catalog keys', () => {
    expect(t('dynamic.key', { defaultValue: 'Provider fallback' }))
      .toBe('Provider fallback')
  })

  it('falls back to the missing-key sentinel behavior', () => {
    // Missing keys remain visible so untranslated server codes are debuggable.
    expect(t('this.key.does.not.exist')).toBe('this.key.does.not.exist')
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
