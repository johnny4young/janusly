/**
 * Serve React's CommonJS entries to ESM importers through named-export facades.
 *
 * Without this, every call site keeps CommonJS interop (`(0,x.useState)(…)`).
 * Named bindings let the bundler and terser reduce each one to a short local.
 * CommonJS packages keep requiring the real entries, so one React instance runs.
 */

import { createRequire } from 'node:module'

const FACADE_PREFIX = '\0janusly-esm:'
const FACADE_SOURCES = new Set(['react', 'react/jsx-runtime'])
const COMMONJS_IMPORTER = /\/node_modules\/(?:react|react-dom|scheduler|use-sync-external-store)\//
const require = createRequire(import.meta.url)

export function reactEsmFacade() {
  return {
    name: 'janusly-react-esm-facade',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!FACADE_SOURCES.has(source) || !importer) return null
      if (importer.startsWith(FACADE_PREFIX) || COMMONJS_IMPORTER.test(importer)) return null
      return { id: `${FACADE_PREFIX}${source}`, moduleSideEffects: false }
    },
    load(id) {
      if (!id.startsWith(FACADE_PREFIX)) return null
      const source = id.slice(FACADE_PREFIX.length)
      return [
        `import real from ${JSON.stringify(source)}`,
        ...Object.keys(require(source)).map((name) => `export const ${name} = real.${name}`),
        'export default real',
      ].join('\n')
    },
  }
}
