import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { leadingAccents, stylesheetAccents } from '../test/leading-accent'
import { ACCENT_SCREENS, RECENT_ALERTS } from '../test/leading-accent-screens'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api, {}) }
})

// Every stylesheet as text, lazy panels included, parsed off-document so the
// sweep cannot change the cascade the rendered screens below are checked in.
const STYLESHEETS = import.meta.glob<string>('../**/*.css', { query: '?inline', import: 'default', eager: true })

describe('leading accent guard', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string) => (path.startsWith('/alerts/recent') ? RECENT_ALERTS : {}))
  })

  it('no stylesheet rule declares a leading strip', () => {
    const hits = Object.entries(STYLESHEETS).flatMap(([path, text]) => stylesheetAccents(text).map(hit => `${path} ${hit}`))
    expect(Object.keys(STYLESHEETS).length).toBeGreaterThan(20)
    expect(hits).toEqual([])
  })

  it.each([
    ['implicit medium width', '.a { border-left: solid var(--we-danger); }'],
    ['rem width', '.a { border: 1px solid var(--we-line); border-left: 0.2rem solid red; }'],
    ['em inline-start width', '.a { border-inline-start: 0.25em solid red; }'],
    ['var() width', '.a { --bar: 3px; border-left: var(--bar) solid red; }'],
    ['width set apart from the style', '.a { border-left-width: 3px; }'],
    ['four-value border-width', '.a { border-width: 0 0 0 4px; border-style: solid; }'],
    ['inset shadow', '.a { box-shadow: inset 3px 0 0 var(--we-primary); }'],
    ['inset shadow in rem', '.a { box-shadow: 0 1px 2px #0002, inset 0.25rem 0 0 red; }'],
    ['logical pseudo inset', '.a::before { content: ""; position: absolute; inset-inline-start: 0; inset-block: 0; width: 3px; }'],
    ['pseudo width without position', '.a[data-tone="danger"]::before { width: 4px; background: red; }'],
    ['stretched flex pseudo', '.a::before { content: ""; width: 3px; align-self: stretch; background: red; }'],
    ['unresolved var() width', '.a { border-left: var(--missing-bar) solid red; }'],
  ])('flags a %s', (_name, css) => {
    expect(stylesheetAccents(css)).toHaveLength(1)
  })

  it.each([
    ['segmented button', '.seg { border: 1px solid var(--we-line); border-right: 0; }'],
    ['right divider', '.d { border-right: 3px solid red; }'],
    ['hairline left divider', '.d { border-left: 1px solid var(--we-line); }'],
    ['symmetric side borders', '.s { border-left: 3px solid red; border-right: 3px solid red; }'],
    ['symmetric four-value border-width', '.s { border-width: 0 3px 0 3px; border-style: solid; }'],
    ['leading side wider than a strip', '.s { border-width: 1px 1px 1px 8px; border-style: solid; }'],
    ['1px hairline inset', '.h { box-shadow: inset 1px 0 0 var(--we-line); }'],
    ['full inset ring', '.r { box-shadow: inset 0 0 0 3px var(--we-primary); }'],
    ['trailing inset', '.t { box-shadow: inset -3px 0 0 red; }'],
    ['offset timeline rail', '.t::before { content: ""; position: absolute; left: 6px; top: 0; bottom: 0; width: 2px; }'],
    ['status dot', '.d::before { content: ""; width: 5px; height: 5px; border-radius: 50%; }'],
    ['allowlisted rule', '.x { border-left: var(--missing-bar) solid red; }', ['.x']],
  ] as const)('passes a %s', (_name, css, allow: readonly string[] = []) => {
    expect(stylesheetAccents(css, allow)).toEqual([])
  })

  it('checks what rendered elements paint, whatever the spelling', () => {
    const { container } = render(
      <div>
        <style>{`
          .t-flex { display: flex; height: 40px; }
          .t-flex::before { content: ""; width: 3px; background: red; }
          .t-logical { position: relative; height: 40px; }
          .t-logical::before { content: ""; position: absolute; inset-inline-start: 0; inset-block: 0; width: 4px; background: red; }
        `}</style>
        <div data-testid="flag-medium" style={{ borderLeft: 'solid red', height: 20 }} />
        <div data-testid="flag-rem" style={{ border: '1px solid #ccc', borderLeftWidth: '0.2rem' }} />
        <div data-testid="flag-inset" style={{ boxShadow: 'inset 3px 0 0 red' }} />
        <div data-testid="flag-flex" className="t-flex" />
        <div data-testid="flag-logical" className="t-logical" />
        <div data-testid="pass-segmented" style={{ border: '1px solid #ccc', borderRight: 0 }} />
        <div data-testid="pass-divider" style={{ borderRight: '3px solid red' }} />
        <div data-testid="pass-hairline" style={{ boxShadow: 'inset 1px 0 0 #ccc' }} />
        <div data-testid="pass-symmetric" style={{ borderLeft: '3px solid red', borderRight: '3px solid red' }} />
      </div>,
    )
    const flagged = (id: string) => leadingAccents(screen.getByTestId(id)).length
    for (const id of ['flag-medium', 'flag-rem', 'flag-inset', 'flag-flex', 'flag-logical']) expect(flagged(id), id).toBe(1)
    for (const id of ['pass-segmented', 'pass-divider', 'pass-hairline', 'pass-symmetric']) expect(flagged(id), id).toBe(0)
    expect(container).toBeInTheDocument()
  })

  it('keeps the focus border on a focused error event', async () => {
    render(ACCENT_SCREENS.find(screenCase => screenCase.name === 'run-events')!.render())
    const failed = await screen.findByTestId('run-event-e-failed')
    failed.style.transition = 'none'
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--we-primary').trim()
    const probe = document.createElement('span')
    probe.style.color = primary
    document.body.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    expect(getComputedStyle(failed).borderTopColor).not.toBe(expected)
    failed.focus()
    expect(failed).toHaveFocus()
    expect(getComputedStyle(failed).borderTopColor).toBe(expected)
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
