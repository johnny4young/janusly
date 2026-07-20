import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RecoveryCenterHero } from './RecoveryCenterHero'

const baseProps = {
  salutation: 'Good afternoon, Jane.',
  subline: 'One run needs recovery.',
  healthScore: 87,
  openFailures: 0,
  streak: { current: 0, longest: 0 },
  onOpenQueue: vi.fn(),
}

describe('<RecoveryCenterHero /> (browser smoke)', () => {
  it('renders the pending memory purge countdown and governance handoff', () => {
    const onOpenMemoryGovernance = vi.fn()
    render(<RecoveryCenterHero
      {...baseProps}
      memoryPurgeCountdown="Memory deletion in 6d 23h"
      onOpenMemoryGovernance={onOpenMemoryGovernance}
    />)
    expect(screen.getByTestId('memory-purge-countdown')).toHaveTextContent('Memory deletion scheduled')
    fireEvent.click(screen.getByRole('button', { name: 'Review memory governance' }))
    expect(onOpenMemoryGovernance).toHaveBeenCalledTimes(1)
  })

  it('lays out downtime severity and clean-streak momentum in real Chromium', () => {
    render(<RecoveryCenterHero
      {...baseProps}
      openFailures={2}
      streak={{ current: 6, longest: 12 }}
      longestOpenMs={5 * 60 * 60 * 1000}
      longestOpenSeverity="danger"
    />)

    const downtime = screen.getByTestId('recovery-center-longest-downtime')
    const streak = screen.getByTestId('recovery-center-clean-streak')
    expect(downtime).toHaveTextContent('Longest downtime: 5h')
    expect(downtime).toHaveAttribute('data-severity', 'danger')
    expect(streak).toHaveTextContent('6-day clean streak')
    expect(downtime.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(streak.getBoundingClientRect().height).toBeGreaterThan(0)
  })

  it('renders the all-clear summary and animated burst as a focused hero state', () => {
    render(<RecoveryCenterHero
      {...baseProps}
      streak={{ current: 9, longest: 14 }}
      allClear
      allClearDowntimeMs={3_660_000}
      celebrationTrigger={1}
    />)

    const hero = screen.getByRole('banner')
    const burst = screen.getByTestId('celebration-burst')
    expect(hero).toHaveAttribute('data-all-clear', 'true')
    expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent(
      '1h 1m of downtime ended this window · 9-day clean streak',
    )
    expect(burst.children).toHaveLength(10)
    expect(hero.getBoundingClientRect().height).toBeGreaterThan(0)
  })

  it('suppresses stale all-clear presentation when a failure is open', () => {
    render(<RecoveryCenterHero
      {...baseProps}
      openFailures={1}
      allClear
      allClearDowntimeMs={3_660_000}
      celebrationTrigger={1}
    />)

    const hero = screen.getByRole('banner')
    expect(hero).not.toHaveAttribute('data-all-clear')
    expect(screen.getByTestId('recovery-center-greeting')).toHaveTextContent('1 run needs recovery')
    expect(screen.queryByTestId('celebration-burst')).toBeNull()
  })

  it('does not promote a sub-threshold streak inside the all-clear summary', () => {
    render(<RecoveryCenterHero
      {...baseProps}
      streak={{ current: 2, longest: 2 }}
      allClear
      allClearDowntimeMs={3_660_000}
    />)

    expect(screen.getByTestId('recovery-center-all-clear-summary')).toHaveTextContent(
      '1h 1m of downtime ended this window',
    )
    expect(screen.getByTestId('recovery-center-all-clear-summary')).not.toHaveTextContent('clean streak')
  })

  it('shows personal recovery momentum only in the calm hero state', () => {
    const personalWins = { recovered: 3, windowDays: 30 }
    const { rerender } = render(<RecoveryCenterHero {...baseProps} personalWins={personalWins} />)

    const wins = screen.getByTestId('recovery-center-personal-wins')
    expect(wins).toHaveTextContent('You recovered 3 failures in the last 30 days')
    expect(wins.getBoundingClientRect().height).toBeGreaterThan(0)

    rerender(<RecoveryCenterHero {...baseProps} personalWins={personalWins} openFailures={1} />)
    expect(screen.queryByTestId('recovery-center-personal-wins')).toBeNull()

    rerender(<RecoveryCenterHero {...baseProps} personalWins={personalWins} allClear />)
    expect(screen.queryByTestId('recovery-center-personal-wins')).toBeNull()
  })
})
