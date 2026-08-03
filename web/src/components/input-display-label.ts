import { t as runtimeT } from '../i18n/runtime'

const UPPERCASE_WORD = /^(ai|api|csv|https?|id|ip|json|llm|mcp|pdf|sql|uri|url|usd|uuid)$/

/** Convert a durable input key into a readable form label without changing it. */
export function inputDisplayLabel(path: string): string {
  const key = path.split('.').at(-1)?.trim() ?? ''
  if (!key) return runtimeT('runInput.fallbackLabel')
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  return words.map((word) => {
    const lower = word.toLowerCase()
    if (UPPERCASE_WORD.test(lower)) return lower.toUpperCase()
    return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`
  }).join(' ')
}
