/**
 * Vite projection for demand-loaded translation catalogs.
 *
 * Locale JSON files remain the authoring source of truth. At build time the
 * canonical key list is emitted once, while each locale chunk carries only its
 * translated values. The runtime then reconstructs the flat i18next resource.
 */

import { readFileSync } from 'node:fs'

const PROJECTION_PARAM = 'janusly-catalog'
const PROJECTIONS = new Set(['keys', 'values'])

function parseProjection(id) {
  const queryIndex = id.indexOf('?')
  if (queryIndex === -1) return null
  const query = new URLSearchParams(id.slice(queryIndex + 1))
  const projection = query.get(PROJECTION_PARAM)
  return projection && PROJECTIONS.has(projection) ? projection : null
}

function sourcePath(id) {
  const queryIndex = id.indexOf('?')
  return queryIndex === -1 ? id : id.slice(0, queryIndex)
}

function assertFlatCatalog(catalog, label) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error(`${label} must be a flat JSON object`)
  }
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value !== 'string') {
      throw new Error(`${label}:${key} must be a string`)
    }
  }
}

export function projectCompactCatalog(canonical, locale, projection, label = 'catalog') {
  assertFlatCatalog(canonical, 'canonical catalog')
  assertFlatCatalog(locale, label)

  const keys = Object.keys(canonical)
  const localeKeys = Object.keys(locale)
  const canonicalSet = new Set(keys)
  const missing = keys.filter((key) => !(key in locale))
  const extra = localeKeys.filter((key) => !canonicalSet.has(key))
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      extra.length > 0 ? `extra: ${extra.join(', ')}` : '',
    ].filter(Boolean).join('; ')
    throw new Error(`${label} does not match the canonical catalog (${details})`)
  }

  return projection === 'keys'
    ? keys
    : keys.map((key) => locale[key])
}

function readCatalog(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function compactI18nCatalogs({ canonicalPath }) {
  return {
    name: 'janusly-compact-i18n-catalogs',
    enforce: 'pre',

    async resolveId(source, importer) {
      const projection = parseProjection(source)
      if (!projection) return null
      const resolved = await this.resolve(sourcePath(source), importer, { skipSelf: true })
      if (!resolved) return null
      return `${sourcePath(resolved.id)}?${PROJECTION_PARAM}=${projection}`
    },

    load(id) {
      const projection = parseProjection(id)
      if (!projection) return null

      const localePath = sourcePath(id)
      this.addWatchFile(canonicalPath)
      this.addWatchFile(localePath)
      const payload = projectCompactCatalog(
        readCatalog(canonicalPath),
        readCatalog(localePath),
        projection,
        localePath,
      )
      return `export default ${JSON.stringify(payload)};`
    },
  }
}
