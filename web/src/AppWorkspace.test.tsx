import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { AppWorkspace, streamStatusLabelKey, type StreamStatus } from './AppWorkspace'
import type { ActiveTab } from './types'

vi.mock('./components/AuthoringPanel', () => ({ AuthoringPanel: () => null }))
vi.mock('./components/AiStudioPanel', () => ({ AiStudioPanel: () => null }))
vi.mock('./components/BuilderSidebar', () => ({ BuilderSidebar: () => null }))
vi.mock('./components/BudgetBlockedBanner', () => ({ BudgetBlockedBanner: () => null }))
vi.mock('./components/CanvasWorkspace', () => ({
  CanvasWorkspace: () => null,
  RunObservationWorkspace: () => null,
}))
vi.mock('./components/UserMenu', () => ({ UserMenu: () => null }))
vi.mock('./components/WorkflowHealthBadge', () => ({ WorkflowHealthBadge: () => null }))
vi.mock('./components/WorkflowReadinessBadge', () => ({ WorkflowReadinessBadge: () => null }))

function renderWorkspace(activeTab: ActiveTab, onOpenTab = vi.fn()) {
  const props = {
    activeTab,
    permissions: ['workflows.read', 'workflows.write'],
    header: {
      environment: 'sandbox',
      organizationLabel: 'default',
      workflowName: 'Draft',
      workflowSaved: false,
      workflowId: 'draft',
      workflowVersion: null,
      workflowRunsCount: 0,
      aiHealth: null,
      streamStatus: 'idle',
      recoveryPosture: 'clear',
      recoveryBlockerCount: 0,
      openRecoveryCount: 0,
      activeRunCount: 0,
    },
    rightPanel: {
      authoring: {},
      catalog: { templates: [], solutionPacks: [], credentials: [] },
      execution: { deadLetters: [] },
      navigation: { onOpenTab },
    },
    canvas: { activated: false, workflowId: 'draft', nodes: [], edges: [] },
    home: {},
    runNodes: [],
    runInput: null,
    palette: { visible: false },
    shortcutsOpen: false,
    snippetMenuOpen: false,
    onOpenTab,
  } as unknown as ComponentProps<typeof AppWorkspace>
  return render(<AppWorkspace {...props} />)
}

describe('<AppWorkspace /> section navigation', () => {
  it.each<ActiveTab>(['inspector', 'ai-studio'])('puts the sections in the top bar on %s', async (tab) => {
    const onOpenTab = vi.fn()
    renderWorkspace(tab, onOpenTab)

    const banner = screen.getByRole('banner')
    const nav = await within(banner).findByRole('navigation', { name: 'Workflows sections' })
    expect(nav).toHaveAttribute('data-testid', 'workspace-section-nav')
    expect(banner).toHaveClass('top-bar--authoring')

    const build = within(nav).getByRole('button', { name: 'Build' })
    expect(build).toHaveAttribute('aria-current', 'page')
    fireEvent.click(within(nav).getByRole('button', { name: 'Templates' }))
    expect(onOpenTab).toHaveBeenCalledWith('templates')
  })

  it('keeps the header row of every other view out of the top bar', async () => {
    renderWorkspace('templates')

    const nav = await screen.findByRole('navigation', { name: 'Workflows sections' })
    expect(within(nav).getByRole('button', { name: 'Templates' })).toHaveAttribute('aria-current', 'page')
    const banner = screen.getByRole('banner')
    expect(banner).not.toHaveClass('top-bar--authoring')
    expect(banner).not.toContainElement(nav)
  })
})

describe('streamStatusLabelKey', () => {
  it.each<[StreamStatus, string]>([
    ['idle', 'statusBar.operatorIdle'],
    ['connecting', 'statusBar.operatorConnecting'],
    ['connected', 'statusBar.operatorOnline'],
    ['closed', 'statusBar.operatorOffline'],
    ['error', 'statusBar.operatorOffline'],
  ])('maps %s without describing a resting system as offline', (status, expected) => {
    expect(streamStatusLabelKey(status)).toBe(expected)
  })
})
