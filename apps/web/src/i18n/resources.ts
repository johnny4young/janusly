/**
 * Static i18n metadata plus the demand-loaded catalog registry. The entry
 * path imports this module, so catalog values MUST stay behind dynamic imports:
 * loading both JSON files here would put every translation on the cold path.
 *
 * Mirror of `lingua/src/shared/i18n/resources.ts`. Adding a new locale is
 * one more entry in `SUPPORTED_LANGUAGES`, a sibling JSON catalog under
 * `apps/web/src/i18n/locales/<lng>/common.json`, and an explicit demand loader.
 */

import type enCommon from './locales/en/common.json'
import { catalogKeys } from './catalog-keys'
import { materializeCatalog } from './compact-catalog'

/** Closed enum of locales the web ships with. */
export const SUPPORTED_LANGUAGES = ['en', 'es'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** App-level setting (what the user picked, including auto-detect sentinel). */
export type AppLanguage = 'system' | SupportedLanguage

/** Resolved runtime locale (what the catalog runtime loads — never `'system'`). */
export type RuntimeLocale = SupportedLanguage

/** Default when nothing else matches. */
export const FALLBACK_LOCALE: RuntimeLocale = 'en'

/** Stable namespace name retained for catalog tooling and compatibility. */
export const COMMON_NAMESPACE = 'common'

/** localStorage key for the user's chosen locale. Convention: `janusly:*` prefix. */
export const LOCALE_STORAGE_KEY = 'janusly:locale'

/** Catalog shape is derived from English so every demand loader stays typed. */
export type CommonCatalog = typeof enCommon
export type CatalogFragment = Record<string, string>
export type CatalogNamespace = 'core' | 'workspace'

/** Translation keys are validated by catalog parity and runtime fallback tests. */
export type TranslationKey = string

/** Interpolation/options accepted by the application translation chokepoint. */
export type TranslationOptions = Record<string, unknown>

/**
 * Translation signature exposed to application code. Keeping the return value
 * concrete keeps call sites lightweight under TypeScript 7; catalog
 * completeness remains enforced by the parity/runtime test suite.
 */
export type Translate = (key: TranslationKey, options?: TranslationOptions) => string

type CatalogModule = { default: string }

/**
 * Explicit per-locale modules keep runtime namespaces independently
 * registerable. Production may coalesce both namespaces for one language into
 * a single compression boundary; do not replace these with eager JSON imports
 * or a broad glob.
 */
const CATALOG_LOADERS: Record<SupportedLanguage, Record<CatalogNamespace, () => Promise<CatalogModule>>> = {
  en: {
    core: () => import('./catalog-core-en'),
    workspace: () => import('./catalog-workspace-en'),
  },
  es: {
    core: () => import('./catalog-core-es'),
    workspace: () => import('./catalog-workspace-es'),
  },
}

const loadedCatalogs: Partial<Record<SupportedLanguage, Partial<Record<CatalogNamespace, CatalogFragment>>>> = {}
const catalogPromises: Partial<Record<SupportedLanguage, Partial<Record<CatalogNamespace, Promise<CatalogFragment>>>>> = {}

/** Return an already-loaded catalog without triggering a network request. */
export function getLoadedLocaleCatalog(
  language: RuntimeLocale,
  namespace: CatalogNamespace = 'core',
): CatalogFragment | undefined {
  return loadedCatalogs[language]?.[namespace]
}

/**
 * Load one local catalog at most once. The selected locale is awaited before
 * React mounts; other locales reach this path only when the operator switches.
 */
export function loadLocaleCatalog(
  language: RuntimeLocale,
  namespace: CatalogNamespace = 'core',
): Promise<CatalogFragment> {
  const loaded = loadedCatalogs[language]?.[namespace]
  if (loaded) return Promise.resolve(loaded)

  const pending = catalogPromises[language]?.[namespace]
  if (pending) return pending

  const promise = CATALOG_LOADERS[language][namespace]().then((module) => {
    const catalog = materializeCatalog(catalogKeys[namespace], module.default)
    const catalogs = loadedCatalogs[language] ?? {}
    catalogs[namespace] = catalog
    loadedCatalogs[language] = catalogs
    return catalog
  }).catch((error: unknown) => {
    if (catalogPromises[language]) delete catalogPromises[language]![namespace]
    throw error
  })
  const promises = catalogPromises[language] ?? {}
  promises[namespace] = promise
  catalogPromises[language] = promises
  return promise
}

export async function loadCompleteLocaleCatalog(language: RuntimeLocale): Promise<CommonCatalog> {
  const [core, workspace] = await Promise.all([
    loadLocaleCatalog(language, 'core'),
    loadLocaleCatalog(language, 'workspace'),
  ])
  return { ...core, ...workspace } as CommonCatalog
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
