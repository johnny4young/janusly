/**
 * Locale bootstrap and demand-loading orchestration.
 *
 * The selected catalog is loaded before React mounts. Re-entry is synchronous
 * for an already-loaded locale so tests and UI updates never render mixed
 * languages between the selection event and the next React pass.
 */

import {
  getLoadedLocaleCatalog,
  loadLocaleCatalog,
  type CatalogFragment,
  type CatalogNamespace,
  type RuntimeLocale,
} from './resources'
import {
  getResolvedLocale,
  i18nRuntime,
  registerRuntimeCatalog,
  setRuntimeLocale,
  type I18nRuntime,
} from './runtime'

const activeNamespaces = new Set<CatalogNamespace>(['core'])
const registeredNamespaces = new Map<RuntimeLocale, Set<CatalogNamespace>>()

function registerCatalog(
  language: RuntimeLocale,
  namespace: CatalogNamespace,
  catalog: CatalogFragment,
): void {
  const registered = registeredNamespaces.get(language) ?? new Set<CatalogNamespace>()
  if (registered.has(namespace)) return
  registerRuntimeCatalog(language, catalog)
  registered.add(namespace)
  registeredNamespaces.set(language, registered)
}

export function initI18n(
  language: RuntimeLocale,
  catalog: CatalogFragment | undefined = getLoadedLocaleCatalog(language, 'core'),
  namespace: CatalogNamespace = 'core',
): I18nRuntime {
  if (!catalog) {
    throw new Error(`Locale catalog must be loaded before initI18n(${language})`)
  }
  registerCatalog(language, namespace, catalog)
  setRuntimeLocale(language)
  return i18nRuntime
}

/** Load the selected catalog, then initialize before React mounts. */
export async function bootstrapI18n(language: RuntimeLocale): Promise<I18nRuntime> {
  const catalog = await loadLocaleCatalog(language, 'core')
  return initI18n(language, catalog)
}

/** Imperative helper to demand-load and swap language at runtime. */
export function changeRuntimeLocale(language: RuntimeLocale): Promise<void> {
  const namespaces = [...activeNamespaces]
  const loaded = namespaces.map((namespace) => getLoadedLocaleCatalog(language, namespace))
  if (loaded.every((catalog): catalog is CatalogFragment => catalog !== undefined)) {
    namespaces.forEach((namespace, index) => registerCatalog(language, namespace, loaded[index]!))
    setRuntimeLocale(language)
    return Promise.resolve()
  }

  return Promise.all(namespaces.map(async (namespace) => {
    const catalog = getLoadedLocaleCatalog(language, namespace)
      ?? await loadLocaleCatalog(language, namespace)
    registerCatalog(language, namespace, catalog)
  })).then(() => setRuntimeLocale(language))
}

export function hasActiveRuntimeNamespace(namespace: CatalogNamespace): boolean {
  return registeredNamespaces.get(getResolvedLocale())?.has(namespace) ?? false
}

export function ensureRuntimeNamespace(namespace: CatalogNamespace): Promise<void> {
  activeNamespaces.add(namespace)
  const language = getResolvedLocale()
  const loaded = getLoadedLocaleCatalog(language, namespace)
  if (loaded) {
    registerCatalog(language, namespace, loaded)
    return Promise.resolve()
  }
  return loadLocaleCatalog(language, namespace).then((catalog) => {
    registerCatalog(language, namespace, catalog)
  })
}
