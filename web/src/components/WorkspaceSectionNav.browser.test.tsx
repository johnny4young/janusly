import { fireEvent, render, screen, within } from '@testing-library/react'
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

  it('names the current section when permissions leave Activity without tabs', () => {
    render(<WorkspaceSectionNav activeTab="reasoning" permissions={['runs.read']} onOpenTab={vi.fn()} />)
    const nav = screen.getByTestId('workspace-section-nav')

    expect(within(nav).queryAllByRole('button')).toHaveLength(0)
    expect(within(nav).getByTestId('workspace-section-context')).toHaveTextContent('Reasoning')
  })

  it('shows the Activity tabs with the open count on Recover only', () => {
    const onOpenTab = vi.fn()
    render(<WorkspaceSectionNav activeTab="multiAgent" openRecoveryCount={2} onOpenTab={onOpenTab} />)
    const nav = screen.getByTestId('workspace-section-nav')

    expect(within(nav).getAllByRole('button').map((button) => button.getAttribute('data-testid'))).toEqual([
      'workspace-section-runs',
      'workspace-section-recover',
      'workspace-section-multiAgent',
      'workspace-section-reports',
    ])
    expect(within(nav).getByRole('button', { name: 'Agent activity' })).toHaveAttribute('aria-current', 'page')
    const recover = within(nav).getByRole('button', { name: 'Recover' })
    expect(within(recover).getByTestId('workspace-section-recover-count')).toHaveTextContent('2')
    expect(recover).toHaveAttribute('title', 'Recover — Recovery · 2 open')
    expect(within(nav).getAllByTestId('workspace-section-recover-count')).toHaveLength(1)

    fireEvent.click(within(nav).getByTestId('workspace-section-reports'))
    expect(onOpenTab).toHaveBeenCalledWith('reports')
  })

  it('hides the Recover count when nothing is open and keeps Recover active for a case', () => {
    render(<WorkspaceSectionNav activeTab="recoveryCase" openRecoveryCount={0} onOpenTab={vi.fn()} />)

    expect(screen.queryByTestId('workspace-section-recover-count')).toBeNull()
    expect(screen.getByTestId('workspace-section-recover')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('workspace-section-runs')).not.toHaveAttribute('aria-current')
  })

  it('keeps the panel title for assistive technology without a second visible header', () => {
    render(<PanelChrome title="Flows" description="Open saved flows."><p>Body</p></PanelChrome>)
    const heading = screen.getByRole('heading', { level: 2, name: 'Flows' })

    expect(heading.getBoundingClientRect().height).toBeLessThanOrEqual(1)
    expect(screen.getByText('Open saved flows.').getBoundingClientRect().height).toBeLessThanOrEqual(1)
  })
})
