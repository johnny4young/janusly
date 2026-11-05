import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RunStepTimeline } from './RunStepTimeline'

const events = [
  { id: 'a', type: 'node.running', nodeId: 'fetch', createdAt: '2026-11-04T12:00:00.000Z', payload: { attempt: 1 } },
  { id: 'b', type: 'node.retry', nodeId: 'fetch', createdAt: '2026-11-04T12:00:00.100Z', payload: { attempt: 2, error: { message: 'boom' } } },
  { id: 'c', type: 'node.running', nodeId: 'fetch', createdAt: '2026-11-04T12:00:00.200Z', payload: { attempt: 2 } },
  { id: 'd', type: 'node.succeeded', nodeId: 'fetch', createdAt: '2026-11-04T12:00:00.300Z', payload: { attempt: 2 } },
  { id: 'e', type: 'node.running', nodeId: 'notify', createdAt: '2026-11-04T12:00:00.300Z', payload: { attempt: 1 } },
  { id: 'f', type: 'node.succeeded', nodeId: 'notify', createdAt: '2026-11-04T12:00:00.400Z', payload: { attempt: 1 } },
]

describe('<RunStepTimeline />', () => {
  it('groups the attempts of this run by step with a retry marker on one time scale', () => {
    render(<RunStepTimeline events={events} nodes={[]} />)

    expect(screen.getByRole('list', { name: 'Steps of this run' })).toBeInTheDocument()
    const fetch = screen.getByTestId('run-step-fetch')
    expect(screen.getByTestId('run-step-retries-fetch')).toHaveTextContent('×1 retry')
    expect(screen.getByTestId('run-step-attempt-fetch-1')).toHaveTextContent('attempt 1 · Retried · 100ms')
    expect(screen.getByTestId('run-step-attempt-fetch-1')).toHaveTextContent('boom')
    expect(screen.getByTestId('run-step-attempt-fetch-2')).toHaveTextContent('attempt 2 · Done · 100ms')

    const bars = [...fetch.querySelectorAll<HTMLElement>('.we-run-step__bar')]
    expect(bars.map(bar => bar.dataset.outcome)).toEqual(['retried', 'succeeded'])
    expect(bars.map(bar => [bar.style.left, bar.style.width])).toEqual([['0%', '25%'], ['50%', '25%']])

    const notify = screen.getByTestId('run-step-notify')
    expect(within(notify).queryByTestId('run-step-retries-notify')).not.toBeInTheDocument()
    expect(within(notify).queryByRole('list')).not.toBeInTheDocument()
    expect(notify.querySelector<HTMLElement>('.we-run-step__bar')?.style.left).toBe('75%')
  })

  it('draws an open attempt up to the latest known time', () => {
    render(<RunStepTimeline events={events.slice(0, 3)} nodes={[]} />)

    const bars = screen.getByTestId('run-step-fetch').querySelectorAll<HTMLElement>('.we-run-step__bar')
    expect(bars[1]?.dataset.outcome).toBe('running')
    expect(bars[1]?.style.width).toBe('0%')
  })

  it('says so when no step has started', () => {
    render(<RunStepTimeline events={[{ id: 'x', type: 'run.started' }]} nodes={[]} />)

    expect(screen.getByText('No step has started yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('loads older events one request at a time', async () => {
    let finish: () => void = () => {}
    const onLoadOlderEvents = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    render(<RunStepTimeline events={events} nodes={[]} eventsHasMore onLoadOlderEvents={onLoadOlderEvents} />)

    const button = screen.getByTestId('run-steps-load-older')
    fireEvent.click(button)
    expect(button).toBeDisabled()
    await act(async () => finish())
    expect(button).toBeEnabled()
    expect(onLoadOlderEvents).toHaveBeenCalledTimes(1)
  })
})
