import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import { CalibrationHealthTile } from './RecoveryCenterTiles'

vi.mock('../../api', () => ({ api: vi.fn() }))

vi.mock('../../store', () => ({
  useWorkflowStore: (selector: (state: { platformVersion: number }) => unknown) => selector({ platformVersion: 0 }),
}))

describe('<CalibrationHealthTile />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })

  it('renders every stored curve with acceptance, sample, slope, and refresh metadata', async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: true,
      windowDays: 30,
      minimumSampleSize: 20,
      calibrations: [{
        approachLabel: 'add_retry',
        acceptRate: 0.8,
        sampleSize: 25,
        curveSlope: 0.92,
        curveIntercept: 4,
        lastComputedAt: '2026-07-10T00:00:00.000Z',
      }],
    })

    render(<CalibrationHealthTile />)

    const row = await screen.findByTestId('recovery-center-calibration-row-add_retry')
    expect(api).toHaveBeenCalledWith('/recovery/calibration-status')
    expect(screen.getByRole('heading', { name: 'Model calibration' })).toBeInTheDocument()
    expect(row).toHaveTextContent('Add retry')
    expect(row).toHaveTextContent('80% accepted')
    expect(row).toHaveTextContent('25 labels')
    expect(row).toHaveTextContent('slope 0.92')
  })

  it('explains that calibration is collecting labels before a curve exists', async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: true,
      windowDays: 30,
      minimumSampleSize: 20,
      calibrations: [],
    })

    render(<CalibrationHealthTile />)

    await waitFor(() => {
      expect(screen.getByText(/No curve is ready yet/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/20 labeled decisions/i)).toBeInTheDocument()
  })

  it('keeps the raw-confidence posture explicit when calibration is disabled', async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: false,
      windowDays: 30,
      minimumSampleSize: 20,
      calibrations: [],
    })

    render(<CalibrationHealthTile />)

    await waitFor(() => {
      expect(screen.getByText(/raw confidence/i)).toBeInTheDocument()
    })
  })

  it('does not turn a missing refresh time into a 1970 date', async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: true,
      windowDays: 30,
      minimumSampleSize: 20,
      calibrations: [{
        approachLabel: 'add_retry',
        acceptRate: 0.8,
        sampleSize: 25,
        curveSlope: 0.92,
        curveIntercept: 4,
        lastComputedAt: null,
      }],
    })

    render(<CalibrationHealthTile />)

    const row = await screen.findByTestId('recovery-center-calibration-row-add_retry')
    expect(row).toHaveTextContent('updated Unknown')
    expect(row).not.toHaveTextContent('1970')
  })
})
