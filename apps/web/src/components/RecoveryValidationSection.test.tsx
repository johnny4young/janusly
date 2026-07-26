import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  downloadFromApi: vi.fn().mockResolvedValue(undefined),
}))

import { downloadFromApi } from '../api'
import {
  RecoveryValidationSection,
  type RecoveryValidationReport,
} from './RecoveryValidationSection'

const downloadMock = vi.mocked(downloadFromApi)
const report: RecoveryValidationReport = {
  generatedAt: '2026-07-21T12:00:00.000Z',
  windowDays: 30,
  sampleLimit: 100,
  sampleCapped: false,
  totals: {
    drills: 4,
    completed: 3,
    recovered: 2,
    acceptedLoss: 1,
    awaitingAction: 1,
    replayInProgress: 0,
    measurementIncomplete: 0,
    missingEvidence: 0,
    completionRatePercent: 75,
    recoveryRatePercent: 66.7,
  },
  resolution: {
    operator: 1,
    automated: 1,
    unknown: 1,
    operatorInterventionRatePercent: 50,
  },
  timing: {
    medianElapsedMs: 90_000,
    p90ElapsedMs: 180_000,
    averageElapsedMs: 90_000,
    p95ElapsedMs: 180_000,
    sampleSize: 2,
  },
  byFailureMode: [{
    key: 'worker_stalled',
    total: 2,
    completed: 2,
    recovered: 1,
    acceptedLoss: 1,
    recoveryRatePercent: 50,
  }],
}

beforeEach(() => {
  downloadMock.mockClear()
})

describe('<RecoveryValidationSection />', () => {
  it('renders explicit drill, completion, actor, and timing evidence', () => {
    render(<RecoveryValidationSection report={report} />)

    expect(screen.getByTestId('recovery-validation-section')).toHaveTextContent('Recovery validation')
    expect(screen.getByText('3/4')).toBeInTheDocument()
    expect(screen.getByText('66.7%')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('1m')).toBeInTheDocument()
    expect(screen.getByText(/p90 3m · 2 recovered samples/i)).toBeInTheDocument()
    expect(screen.getByText(/Worker interrupted/)).toBeInTheDocument()
    expect(screen.getByText(/1 unresolved or incomplete/i)).toBeInTheDocument()
  })

  it('keeps empty, loading, and unavailable evidence distinct', () => {
    const { rerender } = render(<RecoveryValidationSection report={undefined} />)
    expect(screen.getByText(/Loading controlled-drill evidence/i)).toBeInTheDocument()

    rerender(<RecoveryValidationSection report={null} />)
    expect(screen.getByText(/Validation evidence is temporarily unavailable/i)).toBeInTheDocument()

    rerender(<RecoveryValidationSection report={{
      ...report,
      totals: { ...report.totals, drills: 0, completed: 0 },
      byFailureMode: [],
    }} />)
    expect(screen.getByText(/Run a recovery drill from Solution Packs/i)).toBeInTheDocument()
  })

  it('downloads Markdown and JSON with the report window', async () => {
    render(<RecoveryValidationSection report={report} />)

    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(downloadMock).toHaveBeenCalledWith('/reports/recovery-validation?windowDays=30&format=markdown')

    await waitFor(() => expect(screen.getByRole('button', { name: 'JSON' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalledWith('/reports/recovery-validation?windowDays=30&format=json')
    })
  })
})
