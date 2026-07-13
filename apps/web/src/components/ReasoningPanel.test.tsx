import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../types'
import { ReasoningPanel } from './ReasoningPanel'

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

  it('filters by node or payload and distinguishes no matches from no events', () => {
    render(<ReasoningPanel events={[
      { id: 'e1', type: 'node.running', nodeId: 'fetch_invoice', payload: { invoice: 'inv-42' } },
      { id: 'e2', type: 'node.succeeded', nodeId: 'notify_customer', payload: { channel: 'email' } },
    ]} />)

    const filter = screen.getByTestId('run-event-filter')
    fireEvent.change(filter, { target: { value: 'inv-42' } })
    expect(screen.getByText('1 of 2 events')).toBeInTheDocument()
    expect(screen.getByTestId('run-event-e1')).toBeInTheDocument()
    expect(screen.queryByTestId('run-event-e2')).not.toBeInTheDocument()

    fireEvent.change(filter, { target: { value: 'missing-node' } })
    expect(screen.getByText('No matching events')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(screen.getByText('2 of 2 events')).toBeInTheDocument()
  })

  it('clears an active filter and focuses the earliest failure', async () => {
    render(<ReasoningPanel events={[
      { id: 'e1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
      { id: 'e2', type: 'node.failed', nodeId: 'first_failure', createdAt: '2026-07-12T10:00:01.000Z' },
      { id: 'e3', type: 'node.failed', nodeId: 'later_failure', createdAt: '2026-07-12T10:00:02.000Z' },
    ]} />)

    fireEvent.change(screen.getByTestId('run-event-filter'), { target: { value: 'later_failure' } })
    expect(screen.queryByTestId('run-event-e2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Jump to first failure' }))

    await waitFor(() => expect(screen.getByTestId('run-event-filter')).toHaveValue(''))
    await waitFor(() => expect(screen.getByTestId('run-event-e2')).toHaveFocus())
  })

  it('scopes filtering and failure navigation to loaded events when older pages remain', () => {
    render(<ReasoningPanel
      events={[{ id: 'e1', type: 'node.running', nodeId: 'current_page' }]}
      eventsHasMore
      onLoadOlderEvents={() => {}}
    />)

    expect(screen.getByText('1 of 1 loaded event')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Jump to first loaded failure' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Jump to first loaded failure' }))
      .toHaveAttribute('title', 'A failure may be in older events. Load more history first.')

    fireEvent.change(screen.getByTestId('run-event-filter'), { target: { value: 'missing' } })
    expect(screen.getByText('No loaded events match. Load older events to search more history.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load older events' })).toBeInTheDocument()
  })

  it('windows a thousand-event timeline once the scroll owner is measured', async () => {
    const events = Array.from({ length: 1_000 }, (_, index): RunEvent => ({
      id: `event-${index}`,
      type: 'node.running',
      nodeId: `node-${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 12, 10, 0, index)).toISOString(),
    }))
    render(<ReasoningPanel events={events} />)
    const container = screen.getByTestId('run-event-virtual-list')
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 344 })
    fireEvent.scroll(container)

    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeLessThan(20))
    expect(screen.getByRole('list', { name: 'Run event timeline' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-posinset', '1')
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '1000')
    expect(screen.getAllByRole('listitem')[0]).toHaveAccessibleName(/node-999/i)
    expect(screen.getByText('1000 of 1000 events')).toBeInTheDocument()
  })
})
