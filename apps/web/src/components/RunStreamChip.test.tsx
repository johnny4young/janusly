import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunEvent } from '../types'
import { useWorkflowStore } from '../store'
import { RunStreamChip } from './RunStreamChip'

const initialState = useWorkflowStore.getState()

describe('<RunStreamChip />', () => {
  afterEach(() => {
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
})
