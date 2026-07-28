import type { CommonCatalog } from './resources'

export function materializeCatalog(
  keys: readonly string[],
  values: readonly string[],
): CommonCatalog {
  if (keys.length !== values.length) {
    throw new Error('Locale catalog key/value projection is inconsistent')
  }
  const catalog: Record<string, string> = {}
  for (let index = 0; index < keys.length; index += 1) {
    catalog[keys[index]!] = values[index]!
  }
  return catalog as CommonCatalog
}
