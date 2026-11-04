import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PanelChrome } from './panel-primitives'
import { WorkspaceSectionNav } from './WorkspaceSectionNav'

describe('one page header (browser)', () => {
  it('fits the title and tabs in one 56 px row with the helper as a tooltip', () => {
    render(<div style={{ width: 1100 }}><WorkspaceSectionNav activeTab="workflows" onOpenTab={vi.fn()} /></div>)
    const nav = screen.getByTestId('workspace-section-nav')
    const title = within(nav).getByText('Workflows')

    expect(nav.getBoundingClientRect().height).toBe(56)
    expect(title).toHaveAttribute('title', 'Browse saved workflows and versions')
    expect(within(nav).queryByText('Browse saved workflows and versions')).toBeNull()
    expect(within(nav).queryByTestId('workspace-section-context')).toBeNull()
    expect(within(nav).getByRole('button', { name: 'All workflows' })).toHaveAttribute('aria-current', 'page')
  })

  it('names the current section when the destination shows no tabs', () => {
    render(<WorkspaceSectionNav activeTab="recover" onOpenTab={vi.fn()} />)
    const nav = screen.getByTestId('workspace-section-nav')

    expect(within(nav).queryAllByRole('button')).toHaveLength(0)
    expect(within(nav).getByTestId('workspace-section-context')).toHaveTextContent('Recover')
  })

  it('keeps the panel title for assistive technology without a second visible header', () => {
    render(<PanelChrome title="Flows" description="Open saved flows."><p>Body</p></PanelChrome>)
    const heading = screen.getByRole('heading', { level: 2, name: 'Flows' })

    expect(heading.getBoundingClientRect().height).toBeLessThanOrEqual(1)
    expect(screen.getByText('Open saved flows.').getBoundingClientRect().height).toBeLessThanOrEqual(1)
  })
})
