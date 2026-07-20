import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ValueDashboardSection } from './ValueDashboardSection'

describe('<ValueDashboardSection /> (browser smoke)', () => {
  it('lays out the lifetime recovery ledger in real Chromium', () => {
    render(
      <ValueDashboardSection
        mttrMs={60_000}
        mttrDisplay="1m"
        terminalRunsZero={false}
        windowDays={30}
        ledger={{
          totalRecovered: 12,
          downtimeEndedMs: 11_700_000,
          sinceIso: '2026-01-01T00:00:00.000Z',
        }}
      />,
    )

    const ledger = screen.getByTestId('recovery-lifetime-ledger')
    expect(ledger).toHaveTextContent(
      'Since day one: 12 failures recovered · 3h 15m of downtime ended',
    )
    expect(ledger.getBoundingClientRect().height).toBeGreaterThan(0)
  })
})
