import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import { CalibrationHealthTile } from './RecoveryCenterTiles'

vi.mock('../../api', () => {
  const module = ({ api: vi.fn() })
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

vi.mock('../../store', () => ({
  useWorkflowStore: (selector: (state: { platformVersion: number }) => unknown) => selector({ platformVersion: 0 }),
}))

describe('<CalibrationHealthTile /> (browser smoke)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })

  it('lays out the calibrated approach row in real Chromium', async () => {
    vi.mocked(api).mockResolvedValue({
      enabled: true,
      windowDays: 30,
      minimumSampleSize: 20,
      calibrations: [{
        approachLabel: 'raise_timeout',
        acceptRate: 0.72,
        sampleSize: 31,
        curveSlope: 0.84,
        curveIntercept: 6,
        lastComputedAt: '2026-07-10T00:00:00.000Z',
      }],
    })

    render(<CalibrationHealthTile />)

    const row = await screen.findByTestId('recovery-center-calibration-row-raise_timeout')
    expect(row).toHaveTextContent('Raise timeout')
    expect(row).toHaveTextContent('72% accepted')
    expect(row.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(row).display).not.toBe('none')
  })
})
