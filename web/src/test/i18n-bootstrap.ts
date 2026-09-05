import { initI18n } from '../i18n'
import { loadLocaleCatalog } from '../i18n/resources'

// Bootstrap the catalog runtime once for a test suite. Components and helpers
// that route through `t()` need an initialised instance to look up strings;
// the production path runs `initI18n()` in `main.tsx` before any render, but
// vitest doesn't import `main.tsx`. Tests run against the English catalog by
// default; per-test locale switches go through `changeAppLanguage('es')`.
export async function bootstrapTestCatalogs(): Promise<void> {
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
}
