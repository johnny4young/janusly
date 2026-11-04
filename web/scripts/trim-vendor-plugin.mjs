/**
 * Production-only removal of vendor bytes Janusly never runs.
 *
 * Lucide's per-element React keys are random strings gzip cannot compress, and
 * static icon children reconcile by index without them. d3-color only serves
 * color tweens; React Flow's zoom tweens interpolate numbers.
 */

const LUCIDE_ICON = /\/lucide-react\/dist\/esm\/icons\/[^/]+\.mjs$/
const LUCIDE_KEY = /,\s*key:\s*"[^"]*"/g
const D3_COLOR_STUB = '\0janusly-d3-color'

export function trimVendor() {
  return {
    name: 'janusly-trim-vendor',
    apply: 'build',
    enforce: 'pre',
    resolveId(source) {
      return source === 'd3-color' ? D3_COLOR_STUB : null
    },
    load(id) {
      if (id !== D3_COLOR_STUB) return null
      return 'export function color() { return null }\nexport { color as rgb, color as hsl, color as lab, color as hcl, color as cubehelix }'
    },
    transform(code, id) {
      if (!LUCIDE_ICON.test(id)) return null
      return { code: code.replace(LUCIDE_KEY, ''), map: null }
    },
  }
}
