
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Activity } from 'lucide-react'
import { VitalSignsStrip } from './VitalSignsStrip'

describe('<VitalSignsStrip /> (browser smoke)', () => {
  it('announces custom clickable labels with severity in real Chromium', () => {
    render(
      <VitalSignsStrip
        tiles={[
          {
            icon: <Activity />,
            label: 'Failures',
            display: '5',
            severity: 'unhealthy',
            severityLabel: 'Critical',
            ariaLabel: 'Open failed runs in Recovery Center',
            onClick: vi.fn(),
            testId: 'tile-failures',
          },
        ]}
      />,
    )

    expect(screen.getByTestId('tile-failures')).toHaveAccessibleName('Open failed runs in Recovery Center, Critical')
  })

  it('keeps one sparkline point tabbable and activates the keyboard-selected day', () => {
    const onSelectPoint = vi.fn()
    render(
      <VitalSignsStrip
        tiles={[{
          icon: <Activity />,
          label: 'MTTR',
          display: '3m',
          severity: 'healthy',
          onClick: vi.fn(),
          sparkline: [300, 240, 180],
          sparklineLabel: 'MTTR trend',
          sparklinePointLabels: ['2026-07-01: 5m', '2026-07-02: 4m', '2026-07-03: 3m'],
          onSelectSparklinePoint: onSelectPoint,
          testId: 'tile-mttr',
        }]}
      />,
    )

    const last = screen.getByTestId('vitals-sparkline-point-2')
    last.focus()
    fireEvent.keyDown(last, { key: 'ArrowLeft' })
    const selected = screen.getByTestId('vitals-sparkline-point-1')
    expect(document.activeElement).toBe(selected)
    fireEvent.keyDown(selected, { key: 'Enter' })
    expect(onSelectPoint).toHaveBeenCalledWith(1)
  })
})
