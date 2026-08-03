/**
 * Dependency-free translation runtime shared by React and non-React callers.
 *
 * Catalogs stay flat and demand-loaded. This module owns only the capabilities
 * Janusly uses: locale switching, cardinal plurals, interpolation, a missing-key
 * fallback, and a subscription for React consumers.
 */

import {
  FALLBACK_LOCALE,
  type CatalogFragment,
  type RuntimeLocale,
  type Translate,
  type TranslationOptions,
} from './resources'

const catalogs = new Map<RuntimeLocale, CatalogFragment>()
const listeners = new Set<() => void>()
const pluralRules = new Map<RuntimeLocale, Intl.PluralRules>()

let activeLocale: RuntimeLocale = FALLBACK_LOCALE

function pluralCategory(locale: RuntimeLocale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }
  return rules.select(count)
}

function resolveTemplate(
  catalog: CatalogFragment | undefined,
  key: string,
  options: TranslationOptions | undefined,
): string {
  if (!catalog) return String(options?.defaultValue ?? key)

  const count = typeof options?.count === 'number' ? options.count : null
  const pluralKey = count === null ? null : `${key}_${pluralCategory(activeLocale, count)}`
  const record = catalog as Record<string, string>
  return (pluralKey ? record[pluralKey] : undefined)
    ?? record[key]
    ?? String(options?.defaultValue ?? key)
}

function interpolate(template: string, options: TranslationOptions | undefined): string {
  if (!options || !template.includes('{{')) return template
  return template.replace(/\{\{\s*([^},\s]+)\s*\}\}/g, (match, name: string) => {
    const value = options[name]
    return value === undefined || value === null ? match : String(value)
  })
}

/** The non-React translation chokepoint with a bounded application signature. */
export const t: Translate = (key, options) => interpolate(
  resolveTemplate(catalogs.get(activeLocale), key, options),
  options,
)

export function registerRuntimeCatalog(
  language: RuntimeLocale,
  catalog: CatalogFragment,
): void {
  catalogs.set(language, {
    ...(catalogs.get(language) ?? {}),
    ...catalog,
  })
}

export function hasRuntimeCatalog(language: RuntimeLocale): boolean {
  return catalogs.has(language)
}

export function setRuntimeLocale(language: RuntimeLocale): void {
  if (!catalogs.has(language)) {
    throw new Error(`Locale catalog must be registered before selecting ${language}`)
  }
  const changed = activeLocale !== language
  activeLocale = language
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = language
  }
  if (changed) {
    for (const listener of listeners) listener()
  }
}

export function subscribeRuntimeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Read the currently active runtime locale (never `'system'`). */
export function getResolvedLocale(): RuntimeLocale {
  return activeLocale
}

export type I18nRuntime = {
  readonly language: RuntimeLocale
  readonly resolvedLanguage: RuntimeLocale
}

/** Compatibility-shaped read model used by memo dependencies in components. */
export const i18nRuntime: I18nRuntime = {
  get language() {
    return activeLocale
  },
  get resolvedLanguage() {
    return activeLocale
  },
}
