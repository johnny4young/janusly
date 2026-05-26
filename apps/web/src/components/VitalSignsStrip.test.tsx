import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Activity, AlertTriangle } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { VitalSignsStrip } from './VitalSignsStrip'

describe('<VitalSignsStrip />', () => {
  it('renders one card per tile with severity-keyed classes and rationale copy', () => {
    render(
      <VitalSignsStrip
        ariaLabel="Test strip"
        tiles={[
          {
            icon: <Activity data-testid="icon-a" />,
            label: 'Success rate',
            display: '95.0%',
            severity: 'healthy',
            rationale: '11 of 12 runs succeeded.',
            testId: 'tile-success',
          },
          {
            icon: <AlertTriangle data-testid="icon-b" />,
            label: 'Failures',
            display: '3',
            severity: 'warn',
            rationale: '3 open dead-letters.',
            testId: 'tile-failures',
          },
        ]}
      />,
    )

    const success = screen.getByTestId('tile-success')
    const failures = screen.getByTestId('tile-failures')

    expect(success).toBeInTheDocument()
    expect(success.className).toContain('we-ops-metric-card--healthy')
    expect(failures.className).toContain('we-ops-metric-card--warn')
    expect(screen.getByText('Success rate')).toBeInTheDocument()
    expect(screen.getByText('95.0%')).toBeInTheDocument()
    expect(screen.getByText('11 of 12 runs succeeded.')).toBeInTheDocument()
    expect(screen.getByTestId('icon-a')).toBeInTheDocument()
    expect(screen.getByTestId('icon-b')).toBeInTheDocument()
  })

  it('renders a clickable tile as a focusable <button> and fires onClick', () => {
    const onClick = vi.fn()
    render(
      <VitalSignsStrip
        tiles={[
          {
            icon: <Activity />,
            label: 'Failures',
            display: '5',
            severity: 'warn',
            onClick,
            testId: 'tile-failures',
          },
          {
            icon: <Activity />,
            label: 'Static',
            display: '0',
            severity: 'healthy',
            testId: 'tile-static',
          },
        ]}
      />,
    )

    const failures = screen.getByTestId('tile-failures')
    const staticTile = screen.getByTestId('tile-static')
    expect(failures.tagName).toBe('BUTTON')
    expect(staticTile.tagName).toBe('SECTION')
    expect(failures.className).toContain('we-ops-metric-card--button')
    expect(staticTile.className).not.toContain('we-ops-metric-card--button')

    fireEvent.click(failures)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders the progress bar at the clamped width when progressValue is set', () => {
    const { container } = render(
      <VitalSignsStrip
        tiles={[
          {
            icon: <Activity />,
            label: 'Success rate',
            display: '120.0%',
            severity: 'healthy',
            // Out-of-range value to confirm the clamp.
            progressValue: 150,
            testId: 'tile-progress',
          },
        ]}
      />,
    )

    const fill = container.querySelector('.we-ops-progress__fill') as HTMLElement | null
    expect(fill).not.toBeNull()
    expect(fill?.style.width).toBe('100%')
    expect(fill?.className).toContain('we-ops-progress__fill--healthy')
  })

  it('animates toward the formatted display number instead of the raw metric unit', async () => {
    const restoreMatchMedia = stubReducedMotion(true)
    try {
      render(
        <VitalSignsStrip
          tiles={[
            {
              icon: <Activity />,
              label: 'MTTR',
              display: '1m 30s',
              severity: 'warn',
              numericValue: 90_000,
              testId: 'tile-mttr',
            },
            {
              icon: <Activity />,
              label: 'Cost',
              display: '$12.34',
              severity: 'neutral',
              numericValue: 12.34,
              testId: 'tile-cost',
            },
          ]}
        />,
      )

      await waitFor(() => {
        expect(screen.getByTestId('tile-mttr')).toHaveTextContent('1m 30s')
        expect(screen.getByTestId('tile-cost')).toHaveTextContent('$12.34')
      })
      expect(screen.getByTestId('tile-mttr')).not.toHaveTextContent('90000m 30s')
      expect(screen.getByTestId('tile-cost')).not.toHaveTextContent('$12.34$12.34')
    } finally {
      restoreMatchMedia()
    }
  })
})

function stubReducedMotion(matches: boolean): () => void {
  const original = window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  return () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: original,
    })
  }
}
