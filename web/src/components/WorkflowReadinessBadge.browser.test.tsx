import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import { WorkflowReadinessBadge } from './WorkflowReadinessBadge'

vi.mock('../api', () => {
  const module = ({ api: vi.fn() })
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

describe('<WorkflowReadinessBadge /> header summary (browser smoke)', () => {
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

  it('keeps one compact, keyboard-operable route to Problems', async () => {
    const onOpenProblems = vi.fn()
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
            <WorkflowReadinessBadge onOpenProblems={onOpenProblems} />
          </div>
        </div>
      </header>,
    )

    const summary = await screen.findByRole('button', {
      name: 'Open authoring problems — Production · 1 blocker',
    })
    const group = container.querySelector<HTMLElement>('.top-bar-pill-group')
    expect(group).not.toBeNull()
    if (!group) throw new Error('Missing top-bar pill group')

    summary.focus()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(summary).toHaveFocus()
    expect(group.scrollWidth - group.clientWidth).toBeLessThanOrEqual(1)
    expect(group.scrollTop).toBe(0)
    fireEvent.click(summary)
    expect(onOpenProblems).toHaveBeenCalledOnce()
    expect(screen.queryByText('http_missing_bounds')).toBeNull()
  })
})
