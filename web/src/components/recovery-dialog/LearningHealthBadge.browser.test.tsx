import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { initI18n } from '../../i18n'
import { LearningHealthBadge } from './LearningHealthBadge'

describe('<LearningHealthBadge /> (browser smoke)', () => {
  afterEach(() => {
    initI18n('en')
  })

  it('renders the stale learning signal as a visible recovery-dialog state', async () => {
    render(
      <LearningHealthBadge
        approachLabel="add_retry"
        feedbackHealth={{
          windowDays: 30,
          approaches: [{
            approachLabel: 'add_retry',
            feedbackLastSeen: '2026-07-10T00:00:00.000Z',
            acceptedFixLastSeen: '2026-05-29T00:00:00.000Z',
            acceptedFixAgeDays: 42,
            state: 'stale',
          }],
        }}
      />,
    )

    const badge = await screen.findByTestId('recovery-dialog-learning-health')
    expect(badge).toHaveAttribute('data-state', 'stale')
    expect(badge).toHaveTextContent('Learning paused')
    expect(badge.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(badge).display).not.toBe('none')
  })

  it('renders the stale explanation in Spanish when the operator locale changes', async () => {
    initI18n('es')
    render(
      <LearningHealthBadge
        approachLabel="add_retry"
        feedbackHealth={{
          windowDays: 30,
          approaches: [{
            approachLabel: 'add_retry',
            feedbackLastSeen: '2026-07-10T00:00:00.000Z',
            acceptedFixLastSeen: '2026-05-29T00:00:00.000Z',
            acceptedFixAgeDays: 42,
            state: 'stale',
          }],
        }}
      />,
    )

    expect(await screen.findByText('Aprendizaje en pausa')).toBeInTheDocument()
    expect(screen.getByText(/42 días/)).toBeInTheDocument()
  })
})
