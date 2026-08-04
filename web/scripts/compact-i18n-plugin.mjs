/**
 * Vite projection for demand-loaded translation catalogs.
 *
 * Locale JSON files remain the authoring source of truth. At build time the
 * canonical key list is emitted once, while each locale chunk carries only its
 * translated values. The runtime then reconstructs the flat message catalog.
 */

import { readFileSync } from 'node:fs'

const PROJECTION_PARAM = 'janusly-catalog'
const PROJECTIONS = new Set(['keys', 'values'])
const NAMESPACE_PARAM = 'janusly-namespace'
const NAMESPACES = new Set(['core', 'workspace'])
const PACK_SEPARATOR = '\0'

const WORKSPACE_PREFIXES = [
  'activity.',
  'aiStudio.',
  'aiGuidance.',
  'aiReview.',
  'authoring.',
  'authPolicy.',
  'budget.',
  'canvas.',
  'comparison.',
  'credentialRotation.',
  'diff.',
  'dlq.',
  'experiments.',
  'expressionAssistant.',
  'externalRuntime.',
  'mcpConnections.',
  'members.',
  'multiAgent.',
  'nodeDefaults.',
  'nodes.',
  'operations.',
  'permissions.',
  'problems.',
  'readiness.',
  'recoveryCase.',
  'recoveryDialog.',
  'replayCampaign.',
  'replayLab.',
  'reportDelivery.',
  'rightPanel.',
  'rollback.',
  'runEvents.',
  'runExplain.',
  'runHistoryComparison.',
  'runInput.',
  'runStream.',
  'runWorkspace.',
  'scheduleHistory.',
  'scim.',
  'slackInteractions.',
  'snippets.',
  'templates.',
  'tools.',
  'versionHistory.',
  'workflowCreation.',
  'workflowMetadata.',
  'workflowRollout.',
  'workflowsDashboard.',
  'workflowSlo.',
]

function parseCatalogRequest(id) {
  const queryIndex = id.indexOf('?')
  if (queryIndex === -1) return null
  const query = new URLSearchParams(id.slice(queryIndex + 1))
  const projection = query.get(PROJECTION_PARAM)
  const namespace = query.get(NAMESPACE_PARAM)
  if (!projection || !PROJECTIONS.has(projection)) return null
  if (!namespace || !NAMESPACES.has(namespace)) return null
  return { projection, namespace }
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

export function selectCatalogNamespace(catalog, namespace) {
  const inWorkspace = (key) => WORKSPACE_PREFIXES.some((prefix) => key.startsWith(prefix))
  return Object.fromEntries(Object.entries(catalog).filter(([key]) => (
    namespace === 'workspace' ? inWorkspace(key) : !inWorkspace(key)
  )))
}

export function projectCompactCatalog(canonical, locale, projection, label = 'catalog', namespace) {
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

  const projectedKeys = namespace
    ? Object.keys(selectCatalogNamespace(canonical, namespace))
    : keys
  return projection === 'keys'
    ? projectedKeys
    : projectedKeys.map((key) => locale[key])
}

function readCatalog(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Front-code the ordered key list: each token stores the length of the prefix
 * shared with the previous key in its first code unit, followed by the suffix.
 * Translation values keep the same canonical order, so no per-locale key
 * duplication is introduced.
 */
export function frontCodeCatalogKeys(keys) {
  let previous = ''
  return keys.map((key) => {
    if (key.includes(PACK_SEPARATOR)) {
      throw new Error('Catalog keys cannot contain null characters')
    }
    let prefixLength = 0
    while (
      prefixLength < previous.length
      && prefixLength < key.length
      && previous[prefixLength] === key[prefixLength]
    ) {
      prefixLength += 1
    }
    previous = key
    return `${String.fromCharCode(64 + prefixLength)}${key.slice(prefixLength)}`
  }).join(PACK_SEPARATOR)
}

export function packCatalogValues(values) {
  if (values.some((value) => value.includes(PACK_SEPARATOR))) {
    throw new Error('Catalog values cannot contain null characters')
  }
  return values.join(PACK_SEPARATOR)
}

export function compactI18nCatalogs({ canonicalPath }) {
  return {
    name: 'janusly-compact-i18n-catalogs',
    enforce: 'pre',

    async resolveId(source, importer) {
      const request = parseCatalogRequest(source)
      if (!request) return null
      const resolved = await this.resolve(sourcePath(source), importer, { skipSelf: true })
      if (!resolved) return null
      return `${sourcePath(resolved.id)}?${PROJECTION_PARAM}=${request.projection}&${NAMESPACE_PARAM}=${request.namespace}`
    },

    load(id) {
      const request = parseCatalogRequest(id)
      if (!request) return null

      const localePath = sourcePath(id)
      this.addWatchFile(canonicalPath)
      this.addWatchFile(localePath)
      const payload = projectCompactCatalog(
        readCatalog(canonicalPath),
        readCatalog(localePath),
        request.projection,
        localePath,
        request.namespace,
      )
      const output = request.projection === 'keys'
        ? frontCodeCatalogKeys(payload)
        : packCatalogValues(payload)
      return `export default ${JSON.stringify(output)};`
    },
  }
}
