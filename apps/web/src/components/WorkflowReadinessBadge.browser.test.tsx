import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import { WorkflowReadinessBadge } from './WorkflowReadinessBadge'

vi.mock('../api', () => ({ api: vi.fn() }))

describe('<WorkflowReadinessBadge /> header popover (browser smoke)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({
      activeTab: 'home',
      selectedNodeId: null,
      selectedEdgeId: null,
      nodes: [{
        id: 'fetch-customer',
        type: 'workflowStep',
        position: { x: 0, y: 0 },
        data: { label: 'Fetch customer', type: 'http', config: {} },
      }],
    })
  })

  afterEach(() => {
    window.sessionStorage.clear()
  })

  it('keeps an expanded resilience action reachable when it receives focus', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      status: 'fail',
      issues: [{
        code: 'http_missing_bounds',
        severity: 'fail',
        message: 'HTTP node has no bounds',
        nodeId: 'fetch-customer',
        suggestion: 'Set a timeout.',
      }],
    })

    const { container } = render(
      <header className="top-bar">
        <div className="top-bar-right">
          <div className="top-bar-pill-group">
            <WorkflowReadinessBadge />
          </div>
        </div>
      </header>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Production readiness: 1 blocker' }))
    const action = await screen.findByRole('button', { name: 'Open resilience controls' })
    const group = container.querySelector<HTMLElement>('.top-bar-pill-group')
    expect(group).not.toBeNull()
    if (!group) throw new Error('Missing top-bar pill group')

    action.focus()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(action).toHaveFocus()
    expect(getComputedStyle(group).overflow).toBe('visible')
    expect(group.scrollTop).toBe(0)
    expect(action.getBoundingClientRect().top).toBeGreaterThan(group.getBoundingClientRect().bottom)
  })
})
