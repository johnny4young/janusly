/**
 * Built-in snippet copy gate. Every code-shipped built-in snippet
 * (`@janusly/shared:BUILTIN_SNIPPETS`) must carry an EN + ES display name
 * and description in the catalog, plus a label for its category. A new
 * built-in added in shared without its copy keys fails here (the generic
 * parity test only catches EN↔ES drift, not a missing built-in's keys).
 */

import { describe, expect, it } from 'vitest'
import { BUILTIN_SNIPPETS, BUILTIN_SNIPPET_ID_PREFIX, SNIPPET_CATEGORIES } from '@janusly/shared/src/workflow-snippets'
import en from './locales/en/common.json'
import es from './locales/es/common.json'

const EN = en as Record<string, string>
const ES = es as Record<string, string>

function slugOf(id: string): string {
  return id.replace(BUILTIN_SNIPPET_ID_PREFIX, '')
}

describe('built-in snippet i18n copy', () => {
  it.each(BUILTIN_SNIPPETS.map((s) => slugOf(s.id)))(
    'has EN + ES name and description for "%s"',
    (slug) => {
      const nameKey = `snippets.builtin.${slug}.name`
      const descKey = `snippets.builtin.${slug}.description`
      expect(EN[nameKey], `EN ${nameKey}`).toBeTruthy()
      expect(ES[nameKey], `ES ${nameKey}`).toBeTruthy()
      expect(EN[descKey], `EN ${descKey}`).toBeTruthy()
      expect(ES[descKey], `ES ${descKey}`).toBeTruthy()
    },
  )

  it.each(SNIPPET_CATEGORIES)('has EN + ES category label for "%s"', (category) => {
    const key = `snippets.category.${category}`
    expect(EN[key], `EN ${key}`).toBeTruthy()
    expect(ES[key], `ES ${key}`).toBeTruthy()
  })

  it('ships distinct EN vs ES descriptions (real translation, not a copy)', () => {
    // Spot-check one slug to confirm the ES catalog is genuinely translated.
    const slug = 'retry-with-backoff'
    expect(EN[`snippets.builtin.${slug}.description`]).not.toBe(
      ES[`snippets.builtin.${slug}.description`],
    )
  })
})
