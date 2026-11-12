import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { trimVendor } from './trim-vendor-plugin.mjs'

const REACT_FLOW_ID = '/node_modules/@xyflow/react/dist/esm/index.js'
const source = (initializer = 'memo(ResizeControl)', provider = 'react', component = 'function ResizeControl() { return effectWhenRendered() }') => `
import { memo } from '${provider}'
${component}
const NodeResizeControl = ${initializer};
export { NodeResizeControl }
`

test('React Flow purity marks only the known memo factory, without changing its component', () => {
  const result = trimVendor().transform(source(), REACT_FLOW_ID)
  assert.match(result?.code ?? '', /NodeResizeControl = \/\* @__PURE__ \*\/\s*memo\(ResizeControl\)/)
  assert.ok(result.code.includes('function ResizeControl() { return effectWhenRendered() }'))
  assert.ok(result.code.includes('export { NodeResizeControl }'))
})

for (const [name, code] of [
  ['a different callee with the real memo import', source('anotherMemo(ResizeControl)')],
  ['a factory without arguments', source('memo()')],
  ['an evaluated component argument', source('memo(getResizeControl())')],
  ['an evaluated comparator argument', source('memo(ResizeControl, getComparator())')],
  ['a different memo provider', source('memo(ResizeControl)', 'another-library')],
  ['an unbound component', source('memo(ResizeControl)', 'react', '')],
  ['a changed dependency factory', source().replace('NodeResizeControl =', 'OtherControl =')],
]) {
  test(`React Flow purity rejects ${name} instead of assuming it is pure`, () => {
    assert.throws(() => trimVendor().transform(code, REACT_FLOW_ID), /React Flow.*factory changed/)
  })
}

test('React Flow purity follows an aliased React memo import', () => {
  const code = source().replace('{ memo }', '{ memo as memoResize }').replace('= memo(', '= memoResize(')
  const result = trimVendor().transform(code, REACT_FLOW_ID)
  assert.match(result.code, /\/\* @__PURE__ \*\/\s*memoResize\(ResizeControl\)/)
})

test('React Flow purity covers the .mjs entry the package also ships', () => {
  const result = trimVendor().transform(source(), REACT_FLOW_ID.replace(/\.js$/, '.mjs'))
  assert.match(result?.code ?? '', /\/\* @__PURE__ \*\/\s*memo\(ResizeControl\)/)
})

test('React Flow purity does not annotate other modules', () => {
  assert.equal(trimVendor().transform(source(), '/node_modules/another-library/index.js'), null)
})

test('React Flow purity matches the installed dependency and preserves its source', () => {
  const require = createRequire(import.meta.url)
  const packageDir = dirname(require.resolve('@xyflow/react/package.json'))
  const id = join(packageDir, 'dist/esm/index.js')
  const code = readFileSync(id, 'utf8')
  const result = trimVendor().transform(code, id)
  assert.match(result?.code ?? '', /NodeResizeControl = \/\* @__PURE__ \*\/\s*memo\(ResizeControl\)/)
  assert.equal(result.code.replace('/* @__PURE__ */ ', ''), code)
})

test('React Flow purity lets the bundler omit unused resize code and keeps it for an explicit consumer', async () => {
  const { build } = await import('vite')
  const root = dirname(import.meta.dirname)
  const entry = join(root, 'src/react-flow-purity-entry.mjs')
  async function bundle(exportName, plugins) {
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [{
        name: 'react-flow-purity-test-entry',
        resolveId(id) { if (id === entry) return entry },
        load(id) { if (id === entry) return `export { ${exportName} } from '@xyflow/react'` },
      }, ...plugins],
      build: {
        write: false,
        minify: false,
        lib: { entry, formats: ['es'] },
        rollupOptions: { external: ['react', 'react/jsx-runtime'] },
      },
    })
    return (Array.isArray(result) ? result : [result])
      .flatMap((output) => output.output)
      .filter((item) => item.type === 'chunk')
  }
  const original = await bundle('ReactFlowProvider', [])
  const unused = await bundle('ReactFlowProvider', [trimVendor()])
  const used = await bundle('NodeResizeControl', [trimVendor()])
  const code = (chunks) => chunks.map((chunk) => chunk.code).join('\n')
  assert.ok(code(original).includes('react-flow__resize-control'))
  assert.ok(!code(unused).includes('react-flow__resize-control'))
  assert.ok(code(used).includes('react-flow__resize-control'))
  assert.ok(used.some((chunk) => chunk.exports.includes('NodeResizeControl')))
})
