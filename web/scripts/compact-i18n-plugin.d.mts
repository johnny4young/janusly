import type { Plugin } from 'vite'

export function projectCompactCatalog(
  canonical: Record<string, string>,
  locale: Record<string, string>,
  projection: 'keys' | 'values',
  label?: string,
): string[]

export function compactI18nCatalogs(options: {
  canonicalPath: string
}): Plugin
