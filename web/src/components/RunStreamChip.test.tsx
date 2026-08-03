import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../types'
import { useWorkflowStore } from '../store'
import { RunStreamChip } from './RunStreamChip'

const initialState = useWorkflowStore.getState()

describe('<RunStreamChip />', () => {
  afterEach(() => {
    vi.useRealTimers()
    useWorkflowStore.setState(initialState, true)
  })

  it('renders nothing when there is no active run', () => {
    useWorkflowStore.setState({ ...initialState, runId: null, streamTransport: 'idle' }, true)
    const { container } = render(<RunStreamChip />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the Live transport plus an as-of age for the last event', () => {
    const createdAt = new Date(Date.now() - (3 * 60_000 + 30_000)).toISOString() // ~3.5m ago
    const events: RunEvent[] = [{ id: 'e1', type: 'node.completed', createdAt }]
    useWorkflowStore.setState({ ...initialState, runId: 'r1', streamTransport: 'sse', events }, true)
    render(<RunStreamChip />)
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText(/3m ago/)).toBeInTheDocument()
  })

  it('omits the age when there are no events yet', () => {
    useWorkflowStore.setState({ ...initialState, runId: 'r1', streamTransport: 'sse', events: [] }, true)
    render(<RunStreamChip />)
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
  })

  it('runs the as-of timer only while the chip is visible', () => {
    vi.useFakeTimers()
    useWorkflowStore.setState({ ...initialState, runId: 'r1', streamTransport: 'idle' }, true)

    const { container } = render(<RunStreamChip />)
    expect(container).toBeEmptyDOMElement()
    expect(vi.getTimerCount()).toBe(0)

    act(() => useWorkflowStore.setState({ streamTransport: 'polling' }))
    expect(screen.getByText('Polling')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(1)

    act(() => useWorkflowStore.setState({ streamTransport: 'idle' }))
    expect(container).toBeEmptyDOMElement()
    expect(vi.getTimerCount()).toBe(0)
  })
})
