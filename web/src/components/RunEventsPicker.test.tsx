import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RunEventsPicker } from './RunEventsPicker'

const runs = [
  { id: 'run-done-0000', workflowName: 'Report', status: 'succeeded' },
  { id: 'run-fail-0000', workflowName: 'Ingest', status: 'failed' },
  { id: 'run-fail-1111', workflowName: 'Ingest', status: 'failed' },
]

describe('<RunEventsPicker />', () => {
  it('preselects the newest failed run when none is open', () => {
    const onSelectRun = vi.fn()
    render(<RunEventsPicker runs={runs} onSelectRun={onSelectRun} />)

    expect(onSelectRun).toHaveBeenCalledExactlyOnceWith('run-fail-0000')
  })

  it('falls back to the newest run when nothing failed', () => {
    const onSelectRun = vi.fn()
    render(<RunEventsPicker runs={[runs[0]!]} onSelectRun={onSelectRun} />)

    expect(onSelectRun).toHaveBeenCalledExactlyOnceWith('run-done-0000')
  })

  it('never opens a live run by itself, but still offers it', () => {
    const onSelectRun = vi.fn()
    render(<RunEventsPicker runs={[{ id: 'run-wait-0000', workflowName: 'Gate', status: 'waiting' }]} onSelectRun={onSelectRun} />)

    expect(onSelectRun).not.toHaveBeenCalled()
    expect(screen.getByRole('option', { name: /run-wait/ })).toBeInTheDocument()
  })

  it('keeps the open run and switches on selection', () => {
    const onSelectRun = vi.fn()
    render(<RunEventsPicker runs={runs} activeRunId="run-done-0000" onSelectRun={onSelectRun} />)
    expect(onSelectRun).not.toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('run-events-picker'), { target: { value: 'run-fail-1111' } })
    expect(onSelectRun).toHaveBeenCalledExactlyOnceWith('run-fail-1111')
  })

  it('renders nothing without runs', () => {
    const { container } = render(<RunEventsPicker runs={[]} onSelectRun={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
