import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Layout } from './Layout'

const originalMatchMedia = window.matchMedia

function mockMobile(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => {
  document.body.style.overflow = ''
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
})

describe('<Layout /> mobile navigation', () => {
  it('keeps the mobile drawer inert until the trigger opens it', async () => {
    mockMobile(true)
    render(
      <Layout
        sidebar={<button type="button" data-mobile-nav-close="true">Runs</button>}
        main={<div>Recovery Center</div>}
        panel={null}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Navigation' })
    const drawer = document.getElementById('workspace-sidebar')!
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(drawer).toHaveAttribute('inert')
    expect(drawer).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(trigger)
    const close = await screen.findByRole('button', { name: 'Close navigation' })
    await waitFor(() => expect(close).toHaveFocus())
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(drawer).not.toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('closes with Escape and restores focus to the trigger', async () => {
    mockMobile(true)
    render(<Layout sidebar={<span>Sidebar</span>} main={<span>Main</span>} panel={null} />)
    const trigger = screen.getByRole('button', { name: 'Navigation' })
    trigger.focus()
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus())

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.body.style.overflow).toBe('')
  })

  it('closes after a delegated navigation action', async () => {
    mockMobile(true)
    render(
      <Layout
        sidebar={<button type="button" data-mobile-nav-close="true">Runs</button>}
        main={<span>Main</span>}
        panel={null}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Navigation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Runs' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Navigation' })).toHaveAttribute('aria-expanded', 'false'))
  })

  it('leaves the desktop sidebar available without dialog semantics', () => {
    mockMobile(false)
    render(<Layout sidebar={<span>Sidebar</span>} main={<span>Main</span>} panel={null} />)
    const drawer = document.getElementById('workspace-sidebar')!
    expect(drawer).not.toHaveAttribute('role')
    expect(drawer).not.toHaveAttribute('inert')
  })
})
