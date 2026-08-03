import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RecoveryValidationSection } from './RecoveryValidationSection'

describe('<RecoveryValidationSection /> (browser smoke)', () => {
  it('lays out measured evidence and scope boundaries in real Chromium', () => {
    render(
      <RecoveryValidationSection report={{
        generatedAt: '2026-07-21T12:00:00.000Z',
        windowDays: 30,
        sampleLimit: 100,
        sampleCapped: false,
        totals: {
          drills: 2,
          completed: 2,
          recovered: 1,
          acceptedLoss: 1,
          awaitingAction: 0,
          replayInProgress: 0,
          measurementIncomplete: 0,
          missingEvidence: 0,
          completionRatePercent: 100,
          recoveryRatePercent: 50,
        },
        resolution: { operator: 1, automated: 1, unknown: 0, operatorInterventionRatePercent: 50 },
        timing: {
          medianElapsedMs: 90_000,
          p90ElapsedMs: 90_000,
          averageElapsedMs: 90_000,
          p95ElapsedMs: 90_000,
          sampleSize: 1,
        },
        byFailureMode: [],
      }} />,
    )

    const section = screen.getByTestId('recovery-validation-section')
    expect(section).toHaveTextContent('Recovery validation')
    expect(section).toHaveTextContent('2/2')
    expect(section).toHaveTextContent('Per-organization controlled evidence only')
    expect(section.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth + 1)
  })
})
