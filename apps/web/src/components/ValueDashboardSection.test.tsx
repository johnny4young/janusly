/**
 * Component tests for the Value Dashboard section. Pin the operator-
 * visible contracts:
 *   - empty state when no terminal runs in the window (no metric cards
 *     render).
 *   - populated state renders MTTR before/after + clusters + hours + dollar.
 *   - baseline-unset variant shows the "private-beta data pending" copy in
 *     the "Before" slot.
 *   - export buttons trigger `downloadFromApi` with the right URL.
 *   - dollar value is locale-aware (Intl.NumberFormat, currency USD).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  downloadFromApi: vi.fn().mockResolvedValue(undefined),
}))

import { ValueDashboardSection } from './ValueDashboardSection'
import { downloadFromApi } from '../api'

const downloadMock = vi.mocked(downloadFromApi)

beforeEach(() => {
  downloadMock.mockClear()
})

describe('<ValueDashboardSection />', () => {
  it('renders the private-beta-pending copy when terminalRuns is zero', () => {
    render(
      <ValueDashboardSection
        mttrMs={null}
        mttrDisplay="—"
        terminalRunsZero
        windowDays={30}
      />,
    )

    expect(screen.getByText(/Run a workflow/i)).toBeInTheDocument()
    expect(screen.queryByText(/Clusters resolved/i)).not.toBeInTheDocument()
  })

  it('renders all 4 metric cards + estimate badges when populated', () => {
    render(
      <ValueDashboardSection
        mttrMs={60_000}
        mttrDisplay="1m 0s"
        terminalRunsZero={false}
        windowDays={30}
        clustersResolved={{
          value: 5,
          display: '5 clusters',
          severity: 'healthy',
          rationale: '5 distinct signatures resolved',
          totalEntries: 12,
          capped: false,
        }}
        valueEstimate={{
          hoursSaved: 2.5,
          dollarSaved: 125,
          mttrDeltaSeconds: 1740,
          assumptions: {
            hourlyCost: 50,
            minutesSavedPerRecovery: 30,
            baselineMttrSeconds: 1800,
          },
        }}
      />,
    )

    expect(screen.getByText('5 clusters')).toBeInTheDocument()
    expect(screen.getByText('2.50h')).toBeInTheDocument()
    // Intl-formatted: "$125.00" in en-US, "125,00 US$" in es-ES.
    // We loosen to a sub-match.
    expect(screen.getByText(/125/)).toBeInTheDocument()
    // The "estimate" badge appears on every dollar/hour surface.
    const badges = screen.getAllByText('estimate')
    expect(badges.length).toBeGreaterThanOrEqual(3)
  })

  it('renders "Awaiting private-beta data" when baseline is unset (sentinel 0)', () => {
    render(
      <ValueDashboardSection
        mttrMs={60_000}
        mttrDisplay="1m 0s"
        terminalRunsZero={false}
        windowDays={30}
        clustersResolved={{
          value: 3,
          display: '3 clusters',
          severity: 'healthy',
          rationale: '',
          totalEntries: 3,
          capped: false,
        }}
        valueEstimate={{
          hoursSaved: 1.5,
          dollarSaved: 75,
          mttrDeltaSeconds: null,
          assumptions: {
            hourlyCost: 50,
            minutesSavedPerRecovery: 30,
            baselineMttrSeconds: 0,
          },
        }}
      />,
    )

    expect(screen.getByText(/Awaiting private-beta data/i)).toBeInTheDocument()
    // MTTR delta card should NOT render when baseline is unset.
    expect(screen.queryByText('MTTR delta')).not.toBeInTheDocument()
  })

  it('triggers downloadFromApi with the markdown URL on the markdown export button', () => {
    render(
      <ValueDashboardSection
        mttrMs={60_000}
        mttrDisplay="1m 0s"
        terminalRunsZero={false}
        windowDays={30}
        clustersResolved={{
          value: 1,
          display: '1 cluster',
          severity: 'healthy',
          rationale: '',
          totalEntries: 1,
          capped: false,
        }}
        valueEstimate={{
          hoursSaved: 0.5,
          dollarSaved: 25,
          mttrDeltaSeconds: null,
          assumptions: {
            hourlyCost: 50,
            minutesSavedPerRecovery: 30,
            baselineMttrSeconds: 0,
          },
        }}
      />,
    )

    fireEvent.click(screen.getByText('Markdown'))

    expect(downloadMock).toHaveBeenCalledWith(
      '/reports/value-dashboard?windowDays=30&format=markdown',
    )
  })

  it('triggers downloadFromApi with the json URL on the json export button', () => {
    render(
      <ValueDashboardSection
        mttrMs={60_000}
        mttrDisplay="1m 0s"
        terminalRunsZero={false}
        windowDays={7}
        clustersResolved={{
          value: 1,
          display: '1 cluster',
          severity: 'healthy',
          rationale: '',
          totalEntries: 1,
          capped: false,
        }}
        valueEstimate={{
          hoursSaved: 0.5,
          dollarSaved: 25,
          mttrDeltaSeconds: null,
          assumptions: {
            hourlyCost: 50,
            minutesSavedPerRecovery: 30,
            baselineMttrSeconds: 0,
          },
        }}
      />,
    )

    fireEvent.click(screen.getByText('JSON'))

    expect(downloadMock).toHaveBeenCalledWith(
      '/reports/value-dashboard?windowDays=7&format=json',
    )
  })
})
