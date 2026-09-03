import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  RunWorkspaceNavigation,
  type RunWorkspaceView,
} from './RunWorkspace'

function NavigationFixture({ activeRun = true }: { activeRun?: boolean }) {
  const [view, setView] = useState<RunWorkspaceView>('overview')
  return (
    <div className="we-run-workspace" style={{ width: 420 }}>
      <RunWorkspaceNavigation
        activeView={view}
        hasActiveRun={activeRun}
        eventCount={12}
        agentEventCount={4}
        onSelectView={setView}
        onOpenFullView={vi.fn()}
      />
      <div id={`run-workspace-panel-${view}`} role="tabpanel">{view}</div>
    </div>
  )
}

describe('<RunWorkspaceNavigation /> (browser smoke)', () => {
  it('supports roving focus, selection, counts, and compact tap targets in Chromium', async () => {
    render(<NavigationFixture />)

    const overview = screen.getByRole('tab', { name: 'Overview' })
    const timeline = screen.getByRole('tab', { name: 'Timeline, 12 events' })
    const agents = screen.getByRole('tab', { name: 'Agents, 4 multi-agent events' })

    expect(overview).toHaveAttribute('tabindex', '0')
    expect(timeline).toHaveAttribute('tabindex', '-1')
    expect(timeline.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)

    overview.focus()
    fireEvent.keyDown(overview, { key: 'ArrowRight' })
    await waitFor(() => expect(timeline).toHaveFocus())
    expect(timeline).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('timeline')

    fireEvent.keyDown(timeline, { key: 'End' })
    await waitFor(() => expect(agents).toHaveFocus())
    expect(agents).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(agents, { key: 'Home' })
    await waitFor(() => expect(overview).toHaveFocus())
    expect(overview).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps unavailable run-bound tabs disabled', () => {
    render(<NavigationFixture activeRun={false} />)

    expect(screen.getByRole('tab', { name: 'Timeline, 12 events' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Agents, 4 multi-agent events' })).toBeDisabled()
  })
})
