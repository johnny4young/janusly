/**
 * Finds leading accent bars: a 2-6px strip painted on one inline edge of an
 * element, by a one-sided border, a one-sided inset shadow or a pseudo-element.
 * Returns one readable line per offending element, so an assertion on `[]`
 * names what regressed.
 */

const px = (value: string) => Number.parseFloat(value) || 0

function label(element: Element, how: string): string {
  const id = element.getAttribute('data-testid')
  const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
  return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${id ? `[data-testid=${id}]` : ''}: ${how}`
}

function splitShadows(value: string): string[] {
  const shadows: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') depth -= 1
    else if (value[index] === ',' && depth === 0) {
      shadows.push(value.slice(start, index))
      start = index + 1
    }
  }
  shadows.push(value.slice(start))
  return shadows
}

/** An inset shadow offset on x only, with no blur or spread: a side strip. */
export function oneSidedInsetShadow(boxShadow: string): boolean {
  if (!boxShadow || boxShadow === 'none') return false
  return splitShadows(boxShadow).some((shadow) => {
    if (!/\binset\b/.test(shadow)) return false
    const lengths = shadow
      .replace(/[a-z-]+\([^)]*\)/gi, ' ')
      .split(/\s+/)
      .filter((token) => /^-?\d*\.?\d+(px|rem|em)?$/.test(token))
      .map(px)
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths
    return x !== 0 && y === 0 && blur === 0 && spread === 0
  })
}

function oneSidedBorder(style: CSSStyleDeclaration): boolean {
  const width = (side: 'Left' | 'Right') => (style[`border${side}Style`] === 'none' ? 0 : px(style[`border${side}Width`]))
  const left = width('Left')
  const right = width('Right')
  const strip = (near: number, far: number) => near >= 2 && near <= 6 && near > far
  return strip(left, right) || strip(right, left)
}

function pseudoStrip(element: Element, pseudo: '::before' | '::after'): boolean {
  const style = getComputedStyle(element, pseudo)
  if (style.content === 'none' || style.position !== 'absolute') return false
  const width = px(style.width)
  const hostHeight = element.getBoundingClientRect().height
  const atEdge = px(style.left) <= 1 || px(style.right) <= 1
  return width >= 2 && width <= 6 && atEdge && hostHeight > 0 && px(style.height) >= hostHeight * 0.5
}

export function leadingAccents(root: Element): string[] {
  const hits: string[] = []
  for (const element of [root, ...root.querySelectorAll('*')]) {
    const style = getComputedStyle(element)
    if (oneSidedBorder(style)) hits.push(label(element, `border ${style.borderLeftWidth} / ${style.borderRightWidth}`))
    if (oneSidedInsetShadow(style.boxShadow)) hits.push(label(element, `box-shadow ${style.boxShadow}`))
    for (const pseudo of ['::before', '::after'] as const) {
      if (pseudoStrip(element, pseudo)) hits.push(label(element, `${pseudo} strip`))
    }
  }
  return hits
}
