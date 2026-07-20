import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { bootstrapI18n, initI18n } from '../i18n'
import { loadLocaleCatalog } from '../i18n/resources'

// Bootstrap i18next once for the whole test suite. Components and helpers
// that route through `t()` need an initialised instance to look up strings;
// the production path runs `initI18n()` in `main.tsx` before any render, but
// vitest doesn't import `main.tsx`. Tests run against the English catalog by
// default; per-test locale switches go through `changeAppLanguage('es')`.
await bootstrapI18n('en')
await loadLocaleCatalog('es')

beforeEach(() => {
  // Reset to English between tests so locale-mutating tests don't leak.
  initI18n('en')
})

if (typeof globalThis.crypto?.randomUUID !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      ...globalThis.crypto,
      randomUUID: () => 'test-' + Math.random().toString(36).slice(2, 10),
    },
  })
}

afterEach(() => {
  cleanup()
})
