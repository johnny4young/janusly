import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../types'
import { ReasoningPanel } from './RightPanel'

describe('<ReasoningPanel />', () => {
  it('renders payload fields as labelled rows with a raw-JSON toggle, not a raw dump', () => {
    const events: RunEvent[] = [
      {
        id: 'e1',
        type: 'node.completed',
        nodeId: 'http_call',
        payload: { decision: 'accept', attempts: 2, plan: { tool: 'http.request' } },
      },
    ]
    render(<ReasoningPanel events={events} />)

    // Primitive fields show as key → value rows.
    expect(screen.getByText('decision')).toBeInTheDocument()
    expect(screen.getByText('accept')).toBeInTheDocument()
    expect(screen.getByText('attempts')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    // Nested objects collapse to compact inline JSON (the raw toggle has the full shape).
    expect(screen.getByText('plan')).toBeInTheDocument()
    expect(screen.getByText('{"tool":"http.request"}')).toBeInTheDocument()
    // The raw JSON is behind a toggle, not the primary view.
    expect(screen.getByText('Show raw event')).toBeInTheDocument()
    // The node id is still shown.
    expect(screen.getByText('http_call')).toBeInTheDocument()
  })

  it('omits the field list and raw toggle for an empty payload', () => {
    const events: RunEvent[] = [{ id: 'e2', type: 'run.started', payload: {} }]
    render(<ReasoningPanel events={events} />)
    expect(screen.queryByText('Show raw event')).not.toBeInTheDocument()
  })

  it('shows exact timestamps and inter-event deltas while de-emphasizing noise', () => {
    const events: RunEvent[] = [
      { id: 'e3', type: 'node.failed', nodeId: 'fetch', createdAt: '2026-07-12T10:00:03.500Z' },
      { id: 'e1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
      { id: 'e2', type: 'node.queued', nodeId: 'fetch', createdAt: '2026-07-12T10:00:01.250Z' },
    ]
    render(<ReasoningPanel events={events} />)

    expect(screen.getByTestId('run-event-e2')).toHaveAttribute('data-noise', 'true')
    expect(screen.getByTestId('run-event-e2')).toHaveAttribute('data-tone', 'neutral')
    expect(screen.getByTestId('run-event-e3')).toHaveAttribute('data-tone', 'error')
    expect(screen.getByLabelText('1s since the previous event')).toBeInTheDocument()
    expect(screen.getByLabelText('2s since the previous event')).toBeInTheDocument()
    expect(screen.getAllByRole('time')).toHaveLength(3)
    expect(screen.getAllByRole('time')[0]).toHaveAttribute('datetime', '2026-07-12T10:00:03.500Z')
  })
})
