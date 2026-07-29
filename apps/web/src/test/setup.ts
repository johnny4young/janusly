import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { initI18n } from '../i18n'
import { loadLocaleCatalog } from '../i18n/resources'

// Bootstrap the catalog runtime once for the whole test suite. Components and helpers
// that route through `t()` need an initialised instance to look up strings;
// the production path runs `initI18n()` in `main.tsx` before any render, but
// vitest doesn't import `main.tsx`. Tests run against the English catalog by
// default; per-test locale switches go through `changeAppLanguage('es')`.
const [enCore, enWorkspace, esCore, esWorkspace] = await Promise.all([
  loadLocaleCatalog('en', 'core'),
  loadLocaleCatalog('en', 'workspace'),
  loadLocaleCatalog('es', 'core'),
  loadLocaleCatalog('es', 'workspace'),
])
initI18n('en', enCore, 'core')
initI18n('en', enWorkspace, 'workspace')
initI18n('es', esCore, 'core')
initI18n('es', esWorkspace, 'workspace')
initI18n('en')

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
