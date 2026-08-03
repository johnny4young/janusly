import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RecoveryDrillOutcomeCard,
  type RecoveryDrillOutcome,
} from './RecoveryDrillOutcomeCard'

const STARTED = '2026-07-01T10:00:00.000Z'

function outcome(overrides: Partial<RecoveryDrillOutcome> = {}): RecoveryDrillOutcome {
  return {
    status: 'awaiting_action',
    startedAt: STARTED,
    completedAt: null,
    elapsedMs: null,
    evidence: null,
    attemptCount: 1,
    latestDeadLetterId: 'dlq-1',
    chainCapped: false,
    recurrence: {
      status: 'not_applicable',
      windowEndsAt: null,
      recurredAt: null,
    },
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('<RecoveryDrillOutcomeCard />', () => {
  it('shows ongoing elapsed time without claiming terminal evidence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T10:03:00.000Z'))
    render(<RecoveryDrillOutcomeCard outcome={outcome()} />)

    expect(screen.getByRole('status')).toHaveTextContent('Action needed')
    expect(screen.getByText('No terminal recovery evidence yet.')).toBeVisible()
    expect(screen.getByText('3m')).toBeVisible()
    expect(screen.getByText('Recurrence is evaluated after verified recovery.')).toBeVisible()
  })

  it('renders verified duration and active recurrence monitoring', () => {
    render(<RecoveryDrillOutcomeCard outcome={outcome({
      status: 'recovered',
      completedAt: '2026-07-01T10:02:00.000Z',
      elapsedMs: 120_000,
      evidence: 'terminal_impact',
      attemptCount: 2,
      recurrence: {
        status: 'monitoring',
        windowEndsAt: '2026-07-08T10:02:00.000Z',
        recurredAt: null,
      },
    })} />)

    expect(screen.getByRole('status')).toHaveTextContent('Recovered')
    expect(screen.getByText('Verified by generation-matched terminal success.')).toBeVisible()
    expect(screen.getByText('2m')).toBeVisible()
    expect(screen.getByText('2 attempts')).toBeVisible()
    expect(screen.getByText(/No recurrence detected; monitoring through/)).toBeVisible()
  })

  it('distinguishes accepted loss from a recovered outcome', () => {
    render(<RecoveryDrillOutcomeCard outcome={outcome({
      status: 'accepted_loss',
      completedAt: '2026-07-01T10:01:30.000Z',
      elapsedMs: 90_000,
      evidence: 'explicit_resolution',
    })} />)

    expect(screen.getByRole('status')).toHaveTextContent('Accepted loss')
    expect(screen.getByText("Recorded from the operator's accepted-loss decision.")).toBeVisible()
    expect(screen.getByText('1m')).toBeVisible()
  })

  it('refuses to claim an outcome when the bounded replay chain is incomplete', () => {
    render(<RecoveryDrillOutcomeCard outcome={outcome({
      status: 'measurement_incomplete',
      attemptCount: 100,
      chainCapped: true,
    })} />)

    expect(screen.getByRole('status')).toHaveTextContent('Measurement incomplete')
    expect(screen.getByText(/no outcome is claimed/i)).toBeVisible()
    expect(screen.getByText('100 attempts')).toBeVisible()
    expect(screen.getByText(/cannot be evaluated from an incomplete replay chain/i)).toBeVisible()
  })
})
