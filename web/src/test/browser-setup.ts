import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { initI18n } from '../i18n'
import { loadLocaleCatalog } from '../i18n/resources'
import '../index.css'

// Bootstrap the catalog runtime once for the browser-mode suite — components that route
// through `useT()` need an initialised instance to look up strings. The
// production path runs `initI18n()` in `main.tsx`; vitest doesn't import it.
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
  // Reset to English between tests so locale-mutating tests don't leak state.
  initI18n('en')
  // Clear the persisted locale so each switcher test starts from 'system'.
  try { window.localStorage.removeItem('janusly:locale') } catch { /* ignore */ }
})

// Real Chromium ships crypto.randomUUID natively, so unlike the jsdom setup
// we don't polyfill it. Cleanup after every test keeps mounted React Flow
// instances from leaking pointer handlers between cases.
afterEach(() => {
  cleanup()
})
