import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'vite'
import { unwrapColorMixSupports } from './css-floor-plugin.mjs'
import { reactEsmFacade } from './react-esm-facade-plugin.mjs'
import { trimVendor } from './trim-vendor-plugin.mjs'

const require = createRequire(import.meta.url)
const WEB_ROOT = resolve(import.meta.dirname, '..')
const XYFLOW_SYSTEM = realpathSync(join(realpathSync(join(WEB_ROOT, 'node_modules/@xyflow/react')), '../system'))
const outDir = mkdtempSync(join(WEB_ROOT, 'node_modules/.janusly-production-trims-'))
const ENTRY = join(outDir, 'entry.mjs')
writeFileSync(ENTRY, `
export { XYPanZoom } from ${JSON.stringify(XYFLOW_SYSTEM)}
export { Bot } from 'lucide-react'
`)

async function bundle(name, plugins) {
  await build({
    configFile: false,
    root: WEB_ROOT,
    logLevel: 'silent',
    plugins,
    build: {
      outDir: join(outDir, name),
      minify: false,
      lib: { entry: ENTRY, formats: ['es'], fileName: () => 'entry.mjs' },
      rollupOptions: { external: ['react', 'react/jsx-runtime'] },
    },
  })
  return import(pathToFileURL(join(outDir, name, 'entry.mjs')).href)
}

function installBrowser(url) {
  const dom = new JSDOM('<!doctype html><div id="pane"></div>', { url, pretendToBeVisual: true })
  const { window } = dom
  for (const name of ['window', 'document', 'localStorage', 'Element', 'Node', 'requestAnimationFrame']) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: window[name] })
  }
  return dom
}

let trimmed
let original

before(async () => {
  trimmed = await bundle('trimmed', [trimVendor()])
  original = await bundle('original', [])
})
after(() => rmSync(outDir, { recursive: true, force: true }))

test('stubbed d3-color still runs animated and linear React Flow zoom transitions', async () => {
  const dom = installBrowser('https://app.example.test/')
  const { XYPanZoom } = trimmed
  const domNode = document.getElementById('pane')
  const panZoom = XYPanZoom({
    domNode,
    minZoom: 0.1,
    maxZoom: 4,
    translateExtent: [[-Infinity, -Infinity], [Infinity, Infinity]],
    viewport: { x: 0, y: 0, zoom: 1 },
    paneClickDistance: 0,
    onDraggingChange: () => undefined,
    onPanZoomStart: () => undefined,
    onPanZoom: () => undefined,
    onPanZoomEnd: () => undefined,
  })
  for (const interpolate of ['smooth', 'linear']) {
    const target = { x: interpolate === 'smooth' ? 40 : 10, y: 20, zoom: 2 }
    await panZoom.setViewport(target, { duration: 30, interpolate })
    assert.deepEqual(panZoom.getViewport(), target)
  }
  panZoom.destroy()
  dom.window.close()
})

test('lucide icons lose only their React keys', () => {
  const output = readFileSync(join(outDir, 'trimmed', 'entry.mjs'), 'utf8')
  const untouched = readFileSync(join(outDir, 'original', 'entry.mjs'), 'utf8')
  assert.ok(untouched.includes('hb8ula'))
  assert.ok(output.includes('M12 8V4H8'))
  assert.ok(!output.includes('hb8ula'))
})

test('color-mix guards unwrap without touching other at-rules', () => {
  const css = '.a{color:red;@supports (color: color-mix(in lab, red, red)){color:color-mix(in srgb, red 5%, blue);}}'
    + '@supports (display:grid){.b{display:grid}}'
  assert.equal(
    unwrapColorMixSupports(css),
    '.a{color:red;color:color-mix(in srgb, red 5%, blue);}@supports (display:grid){.b{display:grid}}',
  )
})

test('react facade only intercepts ESM importers', () => {
  const plugin = reactEsmFacade()
  assert.equal(plugin.resolveId('react', '/x/node_modules/react-dom/client.js'), null)
  assert.equal(plugin.resolveId('react', '/x/node_modules/use-sync-external-store/shim.js'), null)
  assert.equal(plugin.resolveId('react', '\0janusly-esm:react'), null)
  assert.match(plugin.resolveId('react/jsx-runtime', '/x/src/App.tsx').id, /janusly-esm/)
  const facade = plugin.load('\0janusly-esm:react')
  for (const name of Object.keys(require('react'))) {
    assert.ok(facade.includes(`export const ${name} = real.${name}`), name)
  }
  assert.match(facade, /export default real/)
})
