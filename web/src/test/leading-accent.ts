/**
 * Finds leading accent bars: a 2-6px strip on the leading (left) edge, painted
 * by a one-sided border, a one-sided inset shadow or a pseudo-element.
 * `leadingAccents` checks what rendered elements paint; `stylesheetAccents`
 * resolves each rule of a stylesheet through computed style, so `var()`, rem,
 * em and implicit `medium` widths count. Both return one line per offender.
 */

const px = (value: string) => Number.parseFloat(value) || 0
const isStrip = (width: number) => width >= 2 && width <= 6

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

/** A computed inset shadow offset 2-6px to the right only: a leading strip. */
export function oneSidedInsetShadow(boxShadow: string): boolean {
  if (!boxShadow || boxShadow === 'none') return false
  return splitShadows(boxShadow).some((shadow) => {
    if (!/\binset\b/.test(shadow)) return false
    const [x = 0, y = 0, blur = 0, spread = 0] = shadow
      .replace(/[a-z-]+\([^)]*\)/gi, ' ')
      .split(/\s+/)
      .filter((token) => /^-?\d*\.?\d+(px)?$/.test(token))
      .map(px)
    return isStrip(x) && y === 0 && blur === 0 && spread === 0
  })
}

/** A 2-6px leading border wider than every other side. */
function leadingBorder(style: CSSStyleDeclaration): number | null {
  const width = (side: 'Left' | 'Right' | 'Top' | 'Bottom') => (style[`border${side}Style`] === 'none' ? 0 : px(style[`border${side}Width`]))
  const left = width('Left')
  return isStrip(left) && left > Math.max(width('Right'), width('Top'), width('Bottom')) ? left : null
}

function pseudoStrip(element: Element, pseudo: '::before' | '::after'): boolean {
  const style = getComputedStyle(element, pseudo)
  if (style.content === 'none' || style.display === 'none') return false
  const hostHeight = element.getBoundingClientRect().height
  if (!isStrip(px(style.width)) || hostHeight === 0 || px(style.height) < hostHeight * 0.5) return false
  if (style.position === 'absolute' || style.position === 'fixed') return px(style.left) <= 1
  // An in-flow ::before is the first item of a flex or grid row and stretches.
  return pseudo === '::before' && /flex|grid/.test(getComputedStyle(element).display)
}

export function leadingAccents(root: Element): string[] {
  const hits: string[] = []
  for (const element of [root, ...root.querySelectorAll('*')]) {
    const style = getComputedStyle(element)
    const border = leadingBorder(style)
    if (border !== null) hits.push(label(element, `border-left ${border}px`))
    if (oneSidedInsetShadow(style.boxShadow)) hits.push(label(element, `box-shadow ${style.boxShadow}`))
    for (const pseudo of ['::before', '::after'] as const) {
      if (pseudoStrip(element, pseudo)) hits.push(label(element, `${pseudo} strip`))
    }
  }
  return hits
}

function* styleRules(rules: CSSRuleList): Generator<CSSStyleRule> {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) yield rule
    if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) yield* styleRules((rule as CSSGroupingRule).cssRules)
  }
}

// Block, flex and grid hosts: a pseudo rule may lean on its host for position or stretch.
const PSEUDO_HOSTS = ['position:relative', 'display:flex', 'display:grid']

function probe(sandbox: HTMLElement, hostStyle: string, declarations: string): { host: HTMLElement; child: HTMLElement } {
  const host = document.createElement('div')
  host.setAttribute('style', `${hostStyle};width:240px;height:80px;font-size:16px`)
  const child = document.createElement('span')
  child.setAttribute('style', declarations)
  host.append(child)
  sandbox.append(host)
  return { host, child }
}

function unresolvedVar(rule: CSSStyleRule, isPseudo: boolean): string | null {
  const text = rule.style.cssText
  const property = isPseudo ? /(?:^|;\s*)(?:width|inset-inline-start|left)\s*:\s*([^;]+)/g : /(?:^|;\s*)(?:border-(?:left|inline-start)(?:-width)?|box-shadow)\s*:\s*([^;]+)/g
  const leading = [...text.matchAll(property)].map((match) => match[1]!)
  const root = getComputedStyle(document.documentElement)
  for (const value of leading) {
    for (const [, name] of value.matchAll(/var\((--[\w-]+)/g)) {
      if (!root.getPropertyValue(name!).trim() && !rule.style.getPropertyValue(name!).trim()) return `unresolved ${name}`
    }
  }
  return null
}

/** Rules of `css` that would paint a leading strip; `allow` lists selectors checked by hand. */
export function stylesheetAccents(css: string, allow: readonly string[] = []): string[] {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  const sandbox = document.createElement('div')
  sandbox.setAttribute('style', 'position:fixed;left:-10000px;top:0;direction:ltr')
  document.body.append(sandbox)
  const hits: string[] = []
  try {
    for (const rule of styleRules(sheet.cssRules)) {
      if (allow.includes(rule.selectorText)) continue
      const declarations = rule.style.cssText
      const isPseudo = /::?(before|after)\b/.test(rule.selectorText)
      let accent = unresolvedVar(rule, isPseudo)
      if (!accent && !isPseudo) {
        const { child } = probe(sandbox, 'position:relative', `display:block;border:0 solid;${declarations}`)
        const style = getComputedStyle(child)
        const border = leadingBorder(style)
        if (border !== null) accent = `border-left ${border}px`
        else if (oneSidedInsetShadow(style.boxShadow)) accent = `box-shadow ${style.boxShadow}`
      }
      if (!accent && isPseudo) {
        for (const hostStyle of PSEUDO_HOSTS) {
          const { host, child } = probe(sandbox, hostStyle, declarations)
          const box = child.getBoundingClientRect()
          const edge = host.getBoundingClientRect().left
          if (isStrip(box.width) && box.height >= 40 && Math.abs(box.left - edge) <= 1) {
            accent = `${Math.round(box.width)}px pseudo strip in ${hostStyle}`
            break
          }
        }
      }
      if (accent) hits.push(`${rule.selectorText} { ${accent} }`)
    }
  } finally {
    sandbox.remove()
  }
  return hits
}
