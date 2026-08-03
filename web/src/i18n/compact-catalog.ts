import type { CatalogFragment } from './resources'

export function expandCatalogKeys(encodedKeys: string): string[] {
  const keys: string[] = []
  let previous = ''
  for (const token of encodedKeys.split('\0')) {
    const prefixLength = token.charCodeAt(0) - 64
    if (
      token.length === 0
      || !Number.isInteger(prefixLength)
      || prefixLength < 0
      || prefixLength > previous.length
    ) {
      throw new Error('Locale catalog key projection is invalid')
    }
    const key = previous.slice(0, prefixLength) + token.slice(1)
    keys.push(key)
    previous = key
  }
  return keys
}

export function materializeCatalog(
  encodedKeys: string,
  encodedValues: string | readonly string[],
): CatalogFragment {
  const keys = expandCatalogKeys(encodedKeys)
  const values = typeof encodedValues === 'string'
    ? encodedValues.split('\0')
    : encodedValues
  if (keys.length !== values.length) {
    throw new Error('Locale catalog key/value projection is inconsistent')
  }
  const catalog: Record<string, string> = {}
  for (let index = 0; index < keys.length; index += 1) {
    catalog[keys[index]!] = values[index]!
  }
  return catalog
}
