import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  parseQueueHealth,
  parseQueueHealthOverview,
  QueueLagChip,
  queueNeedsAttention,
} from './QueueLagChip'

describe('queue health browser boundary', () => {
  it('accepts the exact admin shape and rejects malformed or contradictory values', () => {
    expect(parseQueueHealth({
      waiting: 2,
      active: 1,
      oldestWaitingSeconds: 15,
      warnSeconds: 60,
    })).toEqual({ waiting: 2, active: 1, oldestWaitingSeconds: 15, warnSeconds: 60 })
    expect(parseQueueHealth({ waiting: 0, active: 0, oldestWaitingSeconds: 1, warnSeconds: 60 })).toBeNull()
    expect(parseQueueHealth({ waiting: 1.5, active: 0, oldestWaitingSeconds: 1, warnSeconds: 60 })).toBeNull()
    expect(parseQueueHealth({ waiting: 1, active: 0, oldestWaitingSeconds: 1, warnSeconds: 0 })).toBeNull()
  })

  it('distinguishes delayed and unavailable snapshots from healthy processing', () => {
    expect(queueNeedsAttention(null)).toBe(true)
    expect(queueNeedsAttention({ waiting: 1, active: 0, oldestWaitingSeconds: 60, warnSeconds: 60 })).toBe(false)
    expect(queueNeedsAttention({ waiting: 1, active: 0, oldestWaitingSeconds: 61, warnSeconds: 60 })).toBe(true)
  })

  it('parses additive maintenance telemetry without rejecting older APIs', () => {
    const workflow = { waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 60 }
    expect(parseQueueHealthOverview(workflow)).toEqual({ workflow, maintenance: undefined })
    expect(parseQueueHealthOverview({
      ...workflow,
      maintenance: { waiting: 1, active: 0, oldestWaitingSeconds: 301, warnSeconds: 300 },
    })).toEqual({
      workflow,
      maintenance: { waiting: 1, active: 0, oldestWaitingSeconds: 301, warnSeconds: 300 },
    })
  })

  it('does not call a waiting queue clear while its oldest age is racing', () => {
    render(<QueueLagChip health={{ waiting: 2, active: 1, oldestWaitingSeconds: null, warnSeconds: 60 }} />)
    expect(screen.getByTestId('queue-lag-chip')).toHaveAttribute('data-state', 'processing')
    expect(screen.getByText(/2 jobs waiting/i)).toBeInTheDocument()
    expect(screen.queryByText(/queue clear/i)).toBeNull()
  })

  it('keeps poll-driven details outside the live region and describes an idle delayed queue truthfully', () => {
    const { rerender } = render(
      <QueueLagChip
        health={{ waiting: 1, active: 1, oldestWaitingSeconds: 61, warnSeconds: 60 }}
        checkedAt={Date.parse('2026-07-15T12:00:00Z')}
      />,
    )
    const chip = screen.getByTestId('queue-lag-chip')
    const status = within(chip).getByRole('status')
    expect(chip).toHaveTextContent(/Checked/i)
    expect(within(status).queryByText(/Checked/i)).toBeNull()
    expect(status).toHaveTextContent('Workflow queue delayed; workers are still processing')

    rerender(
      <QueueLagChip
        health={{ waiting: 3, active: 1, oldestWaitingSeconds: 125, warnSeconds: 60 }}
        checkedAt={Date.parse('2026-07-15T12:01:00Z')}
      />,
    )
    expect(status).toHaveTextContent('Workflow queue delayed; workers are still processing')
    expect(status).not.toHaveTextContent(/3 jobs|125|Checked/i)

    rerender(<QueueLagChip health={{ waiting: 2, active: 0, oldestWaitingSeconds: 61, warnSeconds: 60 }} />)
    expect(chip).toHaveTextContent('Jobs are waiting for a worker')
    expect(chip).not.toHaveTextContent('Jobs are still processing')
    expect(status).toHaveTextContent('Workflow queue delayed; work is waiting for a worker')
  })

  it('makes Redis and request failures visibly distinguishable', () => {
    const { rerender } = render(<QueueLagChip health={null} unavailableReason="redis" />)
    const chip = screen.getByTestId('queue-lag-chip')
    expect(chip).toHaveTextContent('Queue status unavailable — Redis could not be read')

    rerender(<QueueLagChip health={null} unavailableReason="transport" />)
    expect(chip).toHaveTextContent('Queue status unavailable — request failed')
  })

  it('identifies maintenance queue state independently', () => {
    render(
      <QueueLagChip
        kind="maintenance"
        health={{ waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 300 }}
      />,
    )
    const chip = screen.getByTestId('maintenance-queue-lag-chip')
    expect(chip).toHaveTextContent('Maintenance queue clear')
    expect(within(chip).getByRole('status')).toHaveAttribute(
      'aria-label',
      'Maintenance queue: Maintenance queue clear',
    )
  })
})
