import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { requestAuthoringScope } from './authoring-focus-bus'
import { WorkflowOperationsPanel } from './WorkflowOperationsPanel'

vi.mock('./VersionHistoryPanel', () => ({
  VersionHistoryPanel: () => <div data-testid="versions-panel" />,
}))
vi.mock('./WorkflowRolloutPanel', () => ({
  WorkflowRolloutPanel: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="deployment-panel" data-read-only={String(readOnly)} />
  ),
}))
vi.mock('./WorkflowSloPanel', () => ({
  WorkflowSloPanel: () => <div data-testid="reliability-panel" />,
}))
vi.mock('./ScheduleHistoryPanel', () => ({
  ScheduleHistoryPanel: () => <div data-testid="schedule-panel" />,
}))
vi.mock('./WorkflowMetadataPanel', () => ({
  WorkflowMetadataPanel: () => <div data-testid="about-panel" />,
}))

describe('<WorkflowOperationsPanel />', () => {
  it('loads one optional workflow control at a time and can close it', async () => {
    render(<WorkflowOperationsPanel readOnly />)

    expect(screen.queryByTestId('versions-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }))
    expect(await screen.findByTestId('versions-panel')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Versions' }))
    expect(screen.queryByTestId('versions-panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Deployment' }))
    expect(await screen.findByTestId('deployment-panel')).toHaveAttribute('data-read-only', 'true')
    expect(screen.queryByTestId('versions-panel')).not.toBeInTheDocument()
  })

  it('opens and focuses Versions when a jump names it, once', async () => {
    requestAuthoringScope('workflow', 'versions')
    const first = render(<WorkflowOperationsPanel readOnly />)
    expect(await screen.findByTestId('versions-panel')).toBeInTheDocument()
    expect(document.activeElement).toHaveClass('authoring-workflow-tools')
    first.unmount()

    render(<WorkflowOperationsPanel readOnly />)
    expect(screen.queryByTestId('versions-panel')).not.toBeInTheDocument()

    act(() => requestAuthoringScope('workflow', 'versions'))
    expect(await screen.findByTestId('versions-panel')).toBeInTheDocument()
  })

  it('ignores a jump to another target', () => {
    requestAuthoringScope('workflow', 'outputs')
    render(<WorkflowOperationsPanel readOnly />)
    expect(screen.queryByTestId('versions-panel')).not.toBeInTheDocument()
    expect(document.activeElement).not.toHaveClass('authoring-workflow-tools')
    requestAuthoringScope('step')
  })
})
