import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Activity, AlertTriangle } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { Sparkline, VitalSignsStrip, withSeverityLabels, type VitalSignsTile } from './VitalSignsStrip'

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

  it('announces the severity to screen readers (static tile) since it is color-only', () => {
    render(
      <VitalSignsStrip
        tiles={[
          {
            icon: <Activity />,
            label: 'Success rate',
            display: '95.0%',
            severity: 'healthy',
            severityLabel: 'Healthy',
            testId: 'tile-success',
          },
        ]}
      />,
    )
    const srText = screen.getByText('Healthy')
    expect(srText).toHaveClass('we-sr-only')
    expect(screen.getByTestId('tile-success')).toHaveTextContent('Healthy')
  })

  it('folds the severity into the clickable tile aria-label (label + value + severity)', () => {
    render(
      <VitalSignsStrip
        tiles={[
          {
            icon: <Activity />,
            label: 'Failures',
            display: '5',
            severity: 'warn',
            severityLabel: 'Needs attention',
            onClick: vi.fn(),
            testId: 'tile-failures',
          },
        ]}
      />,
    )
    expect(screen.getByTestId('tile-failures')).toHaveAccessibleName('Failures, 5, Needs attention')
  })

  it('keeps a custom clickable aria-label and still appends severity', () => {
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

  it('withSeverityLabels populates a localized severityLabel from the caller t', () => {
    const t = (key: string) => key.replace('vitals.severity.', '').toUpperCase()
    const tiles: VitalSignsTile[] = [
      { icon: <Activity />, label: 'A', display: '1', severity: 'healthy' },
      { icon: <Activity />, label: 'B', display: '2', severity: 'unhealthy', severityLabel: 'kept' },
    ]
    const out = withSeverityLabels(tiles, t)
    expect(out[0]!.severityLabel).toBe('HEALTHY')
    expect(out[1]!.severityLabel).toBe('kept') // pre-set label is left untouched
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

  it('renders the MTTR trend sparkline when a tile supplies a series', () => {
    render(
      <VitalSignsStrip
        tiles={[
          {
            icon: <Activity />,
            label: 'MTTR',
            display: '3m',
            severity: 'healthy',
            rationale: 'trend',
            sparkline: [300, 240, 180],
            sparklineLabel: 'MTTR trend',
            testId: 'tile-mttr',
          },
        ]}
      />,
    )
    const spark = screen.getByTestId('vitals-sparkline')
    expect(spark.tagName.toLowerCase()).toBe('svg')
    expect(spark.getAttribute('aria-label')).toBe('MTTR trend')
  })

  it('keeps interactive sparkline points outside the metric card button', () => {
    const onClick = vi.fn()
    const onSelectPoint = vi.fn()
    render(
      <VitalSignsStrip
        tiles={[{
          icon: <Activity />,
          label: 'MTTR',
          display: '3m',
          severity: 'healthy',
          sparkline: [300, 240, 180],
          sparklineLabel: 'MTTR trend',
          sparklinePointLabels: ['day 1', 'day 2', 'day 3'],
          onSelectSparklinePoint: onSelectPoint,
          onClick,
          testId: 'tile-mttr',
        }]}
      />,
    )

    const tileAction = screen.getByTestId('tile-mttr')
    const point = screen.getByTestId('vitals-sparkline-point-1')
    expect(tileAction.tagName).toBe('BUTTON')
    expect(tileAction.contains(point)).toBe(false)
    fireEvent.click(tileAction)
    fireEvent.click(point)
    expect(onClick).toHaveBeenCalledOnce()
    expect(onSelectPoint).toHaveBeenCalledWith(1)
  })
})

describe('<Sparkline />', () => {
  it('marks an improving series (last <= mean) as a down/green trend', () => {
    render(<Sparkline points={[300, 240, 120]} ariaLabel="t" />)
    const spark = screen.getByTestId('vitals-sparkline')
    expect(spark.getAttribute('data-trend')).toBe('down')
    expect(spark.className.baseVal ?? spark.getAttribute('class')).toContain('we-sparkline--down')
  })

  it('marks a worsening series (last > mean) as an up/red trend', () => {
    render(<Sparkline points={[120, 240, 600]} ariaLabel="t" />)
    expect(screen.getByTestId('vitals-sparkline').getAttribute('data-trend')).toBe('up')
  })

  it('renders a native <title> hover tooltip when supplied', () => {
    render(<Sparkline points={[300, 180]} ariaLabel="t" title={'2026-07-05: 5m\n2026-07-06: 3m'} />)
    const titleEl = screen.getByTestId('vitals-sparkline').querySelector('title')
    expect(titleEl?.textContent).toContain('2026-07-05: 5m')
  })

  it('renders nothing below two points', () => {
    const { container } = render(<Sparkline points={[42]} ariaLabel="t" />)
    expect(container.querySelector('[data-testid="vitals-sparkline"]')).toBeNull()
  })

  it('announces as an image when labelled', () => {
    render(<Sparkline points={[300, 180]} ariaLabel="MTTR trend" />)
    const spark = screen.getByTestId('vitals-sparkline')
    expect(spark.getAttribute('role')).toBe('img')
    expect(spark.getAttribute('aria-label')).toBe('MTTR trend')
    expect(spark.getAttribute('aria-hidden')).toBeNull()
  })

  it('is decorative (aria-hidden, no role=img) when unlabelled — no unnamed image in the a11y tree', () => {
    render(<Sparkline points={[300, 180]} />)
    const spark = screen.getByTestId('vitals-sparkline')
    expect(spark.getAttribute('role')).toBeNull()
    expect(spark.getAttribute('aria-label')).toBeNull()
    expect(spark.getAttribute('aria-hidden')).toBe('true')
  })

  it('uses one roving point stop and supports arrows, Home/End, and keyboard selection', () => {
    const onSelectPoint = vi.fn()
    render(
      <Sparkline
        points={[300, 240, 180]}
        ariaLabel="MTTR trend"
        pointLabels={['day 1', 'day 2', 'day 3']}
        onSelectPoint={onSelectPoint}
      />,
    )

    const first = screen.getByTestId('vitals-sparkline-point-0')
    const second = screen.getByTestId('vitals-sparkline-point-1')
    const last = screen.getByTestId('vitals-sparkline-point-2')
    expect([first, second, last].filter((point) => point.tabIndex === 0)).toEqual([last])

    last.focus()
    fireEvent.keyDown(last, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(second, { key: 'Home' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'End' })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Enter' })
    expect(onSelectPoint).toHaveBeenCalledWith(2)
    fireEvent.keyDown(last, { key: ' ' })
    expect(onSelectPoint).toHaveBeenNthCalledWith(2, 2)
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
