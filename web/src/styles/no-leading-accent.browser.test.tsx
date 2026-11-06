import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { leadingAccents, oneSidedInsetShadow } from '../test/leading-accent'
import { ACCENT_SCREENS, RECENT_ALERTS } from '../test/leading-accent-screens'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api, {}) }
})

// Every stylesheet as text, lazy panels included, parsed off-document so the
// sweep cannot change the cascade the rendered screens below are checked in.
const STYLESHEETS = import.meta.glob<string>('../**/*.css', { query: '?inline', import: 'default', eager: true })

const LENGTH = /(-?\d*\.?\d+)px/

function stripWidth(value: string): number {
  const match = LENGTH.exec(value)
  return match ? Number.parseFloat(match[1]!) : 0
}

function* styleRules(rules: CSSRuleList): Generator<CSSStyleRule> {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) yield rule
    if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) yield* styleRules((rule as CSSGroupingRule).cssRules)
  }
}

/** Declarations that would paint a 2-6px strip on one inline edge. */
function ruleAccent(rule: CSSStyleRule): string | null {
  const text = rule.style.cssText
  for (const [, side, value] of text.matchAll(/border-(left|right|inline-start|inline-end)(?:-width)?\s*:\s*([^;]+)/g)) {
    const width = stripWidth(value!)
    if (width >= 2 && width <= 6) return `border-${side}: ${value}`
  }
  const widths = /(?:^|;)\s*border-width\s*:\s*([^;]+)/.exec(text)?.[1]?.trim().split(/\s+/)
  if (widths?.length === 4 && stripWidth(widths[3]!) !== stripWidth(widths[1]!)) return `border-width: ${widths.join(' ')}`
  const shadow = /(?:^|;)\s*box-shadow\s*:\s*([^;]+)/.exec(text)?.[1]
  if (shadow && oneSidedInsetShadow(shadow)) return `box-shadow: ${shadow}`
  if (/::?(before|after)/.test(rule.selectorText) && rule.style.position === 'absolute') {
    const width = stripWidth(rule.style.width)
    const atEdge = rule.style.left === '0px' || rule.style.right === '0px' || rule.style.left === '0' || rule.style.right === '0'
    const fullHeight = rule.style.height === '100%' || ((rule.style.top === '0px' || rule.style.top === '0') && (rule.style.bottom === '0px' || rule.style.bottom === '0'))
    if (width >= 2 && width <= 6 && atEdge && fullHeight) return `${rule.style.width} ${rule.selectorText} strip`
  }
  return null
}

describe('leading accent guard', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string) => (path.startsWith('/alerts/recent') ? RECENT_ALERTS : {}))
  })

  it('no stylesheet rule declares a one-sided edge strip', () => {
    const hits: string[] = []
    for (const [path, text] of Object.entries(STYLESHEETS)) {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(text)
      for (const rule of styleRules(sheet.cssRules)) {
        const accent = ruleAccent(rule)
        if (accent) hits.push(`${path} ${rule.selectorText} { ${accent} }`)
      }
    }
    expect(Object.keys(STYLESHEETS).length).toBeGreaterThan(20)
    expect(hits).toEqual([])
  })

  it('keeps the status those bars carried in text or an icon name', async () => {
    const screenFor = (name: string) => ACCENT_SCREENS.find(screenCase => screenCase.name === name)!.render()
    render(<>{screenFor('home-priority')}{screenFor('vital-signs')}{screenFor('recent-alerts')}</>)
    expect(within(screen.getByTestId('recovery-center-action-action-warning')).getByRole('img', { name: 'Warning' })).toBeVisible()
    expect(within(screen.getByTestId('recovery-center-action-action-danger')).getByRole('img', { name: 'Critical' })).toBeVisible()
    expect(within(screen.getByTestId('recovery-center-action-action-cobalt')).queryByRole('img')).toBeNull()
    expect(within(screen.getByTestId('vital-unhealthy')).getByText('Critical')).toBeVisible()
    expect(within(screen.getByTestId('vital-warn')).getByText('Needs attention')).toBeVisible()
    const [delivered, failed] = await screen.findAllByTestId('recent-alert-row')
    expect(within(delivered!).getByText('Delivered')).toHaveAttribute('data-tone', 'success')
    expect(within(failed!).getByText('Delivery failed')).toHaveAttribute('data-tone', 'warning')
  })

  const cases = ACCENT_SCREENS.flatMap(screenCase => (['light', 'dark'] as const).map(theme => [screenCase.name, theme, screenCase] as const))

  it.each(cases)('%s paints no leading accent (%s)', async (_name, theme, screenCase) => {
    document.documentElement.dataset.theme = theme
    try {
      const { container } = render(screenCase.render())
      await screen.findAllByTestId(screenCase.ready)
      expect(leadingAccents(container)).toEqual([])
    } finally {
      delete document.documentElement.dataset.theme
    }
  })
})
