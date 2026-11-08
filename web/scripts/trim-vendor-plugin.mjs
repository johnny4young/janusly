/**
 * Production-only removal of vendor bytes Janusly never runs.
 *
 * Lucide's per-element React keys are random strings gzip cannot compress, and
 * static icon children reconcile by index without them. An unused React Flow
 * memo factory can be removed without dropping its exported API. d3-color and most of
 * d3-transition serve attr/style tweens; React Flow only runs zoom tweens.
 */

import { parseSync } from 'oxc-parser'

const REACT_FLOW_MODULE = /\/@xyflow\/react\/dist\/esm\/index\.js$/
const LUCIDE_ICON = /\/lucide-react\/dist\/esm\/icons\/[^/]+\.mjs$/
const LUCIDE_KEY = /,\s*key:\s*"[^"]*"/g
const D3_TRANSITION_INDEX = /\/d3-transition\/src\/transition\/index\.js$/
const UNUSED_TRANSITION_METHODS = new Set([
  './attr.js', './attrTween.js', './delay.js', './easeVarying.js', './end.js', './filter.js',
  './merge.js', './remove.js', './select.js', './selectAll.js', './style.js', './styleTween.js',
  './text.js', './textTween.js', './transition.js',
])
const UNSUPPORTED_METHOD = '\0janusly-d3-unsupported'
const D3_COLOR_STUB = '\0janusly-d3-color'

/** React.memo stores the component; it does not render it. Keep the full API
 * when imported, but let tree shaking drop the unused resize-control factory.
 * Check the binding and unevaluated argument so a dependency update cannot
 * silently extend this annotation to a call with initialization side effects.
 */
function annotateResizeControl(code) {
  const { program, errors } = parseSync('react-flow.js', code, { sourceType: 'module' })
  const body = program.body
  const declaration = body.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : [])
    .find((node) => node.id.type === 'Identifier' && node.id.name === 'NodeResizeControl')
  const call = declaration?.init
  const memoBinding = body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === 'react')
    .flatMap((node) => node.specifiers)
    .find((node) => node.type === 'ImportSpecifier' && node.imported.name === 'memo')
  const component = call?.arguments?.[0]
  if (
    errors.length > 0
    || !memoBinding
    || call?.type !== 'CallExpression'
    || call.callee.type !== 'Identifier'
    || call.callee.name !== memoBinding.local.name
    || call.arguments.length !== 1
    || component.type !== 'Identifier'
    || !body.some((node) => node.type === 'FunctionDeclaration' && node.id?.name === component.name)
  ) {
    throw new Error('React Flow resize-control factory changed; review its pure annotation')
  }
  return code.slice(0, call.start) + '/* @__PURE__ */ ' + code.slice(call.start)
}

export function trimVendor() {
  return {
    name: 'janusly-trim-vendor',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'd3-color') return D3_COLOR_STUB
      if (importer && D3_TRANSITION_INDEX.test(importer) && UNUSED_TRANSITION_METHODS.has(source)) {
        return UNSUPPORTED_METHOD
      }
      return null
    },
    load(id) {
      if (id === UNSUPPORTED_METHOD) {
        return "export default function () { throw new Error('Unsupported d3 transition method') }"
      }
      if (id === D3_COLOR_STUB) {
        return 'export function color() { return null }\nexport { color as rgb, color as hsl, color as lab, color as hcl, color as cubehelix }'
      }
      return null
    },
    transform(code, id) {
      if (REACT_FLOW_MODULE.test(id)) return { code: annotateResizeControl(code), map: null }
      if (!LUCIDE_ICON.test(id)) return null
      return { code: code.replace(LUCIDE_KEY, ''), map: null }
    },
  }
}
