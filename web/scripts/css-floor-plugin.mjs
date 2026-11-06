/**
 * Drop Tailwind's `color-mix` fallback branch at build time. Every browser in
 * Vite's build target supports `color-mix(in lab, ...)`, so the `@supports`
 * guard is always true and its fallback declaration is never the winner.
 */

const COLOR_MIX_GUARD = /@supports\s*\(color:\s*color-mix\(in lab,\s*red,\s*red\)\)\s*\{/g

export function unwrapColorMixSupports(css) {
  let output = ''
  let cursor = 0
  for (const match of css.matchAll(COLOR_MIX_GUARD)) {
    if (match.index < cursor) continue
    const bodyStart = match.index + match[0].length
    let depth = 1
    let end = bodyStart
    for (; end < css.length && depth > 0; end += 1) {
      if (css[end] === '{') depth += 1
      else if (css[end] === '}') depth -= 1
    }
    output += css.slice(cursor, match.index) + css.slice(bodyStart, end - 1)
    cursor = end
  }
  return output + css.slice(cursor)
}

export function cssFloor() {
  return {
    name: 'janusly-css-floor',
    apply: 'build',
    transform(code, id) {
      if (!/\.css(?:$|\?)/.test(id) || !code.includes('color-mix(in lab')) return null
      return { code: unwrapColorMixSupports(code), map: null }
    },
  }
}
