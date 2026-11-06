/**
 * Production-only removal of vendor bytes Janusly never runs.
 *
 * Lucide's per-element React keys are random strings gzip cannot compress, and
 * static icon children reconcile by index without them. d3-color and most of
 * d3-transition serve attr/style tweens; React Flow only runs zoom tweens.
 */

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
      if (!LUCIDE_ICON.test(id)) return null
      return { code: code.replace(LUCIDE_KEY, ''), map: null }
    },
  }
}
