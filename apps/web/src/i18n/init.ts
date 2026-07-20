/**
 * i18next bootstrap. The selected local catalog is loaded before `createRoot`,
 * then initialization itself remains synchronous and Suspense-free.
 *
 * Re-entry safe: subsequent calls just dispatch `changeLanguage` so the
 * ZUSTAND store / React tree can hot-swap locale without re-init.
 */

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  COMMON_NAMESPACE,
  getLoadedLocaleCatalog,
  loadLocaleCatalog,
  type CommonCatalog,
  type RuntimeLocale,
} from './resources'

let initialized = false

/** Update `<html lang>` so screen readers / browser features pick the right locale. */
function updateDocumentLanguage(language: RuntimeLocale): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = language
  }
}

function registerCatalog(language: RuntimeLocale, catalog: CommonCatalog): void {
  if (!i18next.hasResourceBundle(language, COMMON_NAMESPACE)) {
    i18next.addResourceBundle(language, COMMON_NAMESPACE, catalog, true, true)
  }
}

/**
 * Initialize i18next from an already-loaded catalog. Idempotent — repeat calls
 * register the catalog if needed, then synchronously start the language swap.
 */
export function initI18n(
  language: RuntimeLocale,
  catalog: CommonCatalog | undefined = getLoadedLocaleCatalog(language),
): typeof i18next {
  if (!catalog) {
    throw new Error(`Locale catalog must be loaded before initI18n(${language})`)
  }
  if (initialized) {
    registerCatalog(language, catalog)
    void i18next.changeLanguage(language)
    updateDocumentLanguage(language)
    return i18next
  }
  initialized = true
  void i18next.use(initReactI18next).init({
    lng: language,
    // Catalog parity is a hard test gate. Keeping fallback disabled means the
    // cold path downloads exactly the selected locale rather than English too.
    fallbackLng: false,
    defaultNS: COMMON_NAMESPACE,
    ns: [COMMON_NAMESPACE],
    initAsync: false,
    resources: { [language]: { [COMMON_NAMESPACE]: catalog } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    returnNull: false,
    returnEmptyString: false,
  })
  updateDocumentLanguage(language)
  return i18next
}

/** Load the selected catalog, then initialize before React mounts. */
export async function bootstrapI18n(language: RuntimeLocale): Promise<typeof i18next> {
  const catalog = await loadLocaleCatalog(language)
  return initI18n(language, catalog)
}

/** Imperative helper to demand-load and swap language at runtime. */
export function changeRuntimeLocale(language: RuntimeLocale): Promise<void> {
  const loaded = getLoadedLocaleCatalog(language)
  if (loaded) {
    registerCatalog(language, loaded)
    const changed = i18next.changeLanguage(language)
    updateDocumentLanguage(language)
    return changed.then(() => undefined)
  }

  return loadLocaleCatalog(language).then(async (catalog) => {
    registerCatalog(language, catalog)
    await i18next.changeLanguage(language)
    updateDocumentLanguage(language)
  })
}
