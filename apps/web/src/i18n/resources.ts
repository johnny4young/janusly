/**
 * Static i18n metadata plus the demand-loaded catalog registry. The entry
 * path imports this module, so catalog values MUST stay behind dynamic imports:
 * loading both JSON files here would put every translation on the cold path.
 *
 * Mirror of `lingua/src/shared/i18n/resources.ts`. Adding a new locale is
 * one more entry in `SUPPORTED_LANGUAGES`, a sibling JSON catalog under
 * `apps/web/src/i18n/locales/<lng>/common.json`, and an explicit demand loader.
 */

/** Closed enum of locales the web ships with. */
export const SUPPORTED_LANGUAGES = ['en', 'es'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** App-level setting (what the user picked, including auto-detect sentinel). */
export type AppLanguage = 'system' | SupportedLanguage

/** Resolved runtime locale (what i18next actually loads — never `'system'`). */
export type RuntimeLocale = SupportedLanguage

/** Default when nothing else matches. */
export const FALLBACK_LOCALE: RuntimeLocale = 'en'

/** Single-namespace setup mirrors lingua. */
export const COMMON_NAMESPACE = 'common'

/** localStorage key for the user's chosen locale. Convention: `janusly:*` prefix. */
export const LOCALE_STORAGE_KEY = 'janusly:locale'

/** Catalog shape is derived from English so loaders and i18next stay typed. */
export type CommonCatalog = typeof import('./locales/en/common.json').default

type CatalogModule = { default: CommonCatalog }

/**
 * Explicit per-locale modules give production chunks stable, reviewable names.
 * Do not replace these with eager JSON imports or a broad glob.
 */
const CATALOG_LOADERS: Record<SupportedLanguage, () => Promise<CatalogModule>> = {
  en: () => import('./catalog-en'),
  es: () => import('./catalog-es'),
}

const loadedCatalogs: Partial<Record<SupportedLanguage, CommonCatalog>> = {}
const catalogPromises: Partial<Record<SupportedLanguage, Promise<CommonCatalog>>> = {}

/** Return an already-loaded catalog without triggering a network request. */
export function getLoadedLocaleCatalog(language: RuntimeLocale): CommonCatalog | undefined {
  return loadedCatalogs[language]
}

/**
 * Load one local catalog at most once. The selected locale is awaited before
 * React mounts; other locales reach this path only when the operator switches.
 */
export function loadLocaleCatalog(language: RuntimeLocale): Promise<CommonCatalog> {
  const loaded = loadedCatalogs[language]
  if (loaded) return Promise.resolve(loaded)

  const pending = catalogPromises[language]
  if (pending) return pending

  const promise = CATALOG_LOADERS[language]().then((module) => {
    loadedCatalogs[language] = module.default
    return module.default
  }).catch((error: unknown) => {
    delete catalogPromises[language]
    throw error
  })
  catalogPromises[language] = promise
  return promise
}

/** Type-guard — does the raw string name a supported locale? */
export function isSupportedLanguage(language: string): language is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(language)
}

/** Type-guard — does the raw string name a valid app-level setting? */
export function isAppLanguage(language: string): language is AppLanguage {
  return language === 'system' || isSupportedLanguage(language)
}

/** Coerce any string to a runtime locale, falling back to `FALLBACK_LOCALE`. */
export function coerceSupportedLanguage(language: string): RuntimeLocale {
  return isSupportedLanguage(language) ? language : FALLBACK_LOCALE
}
