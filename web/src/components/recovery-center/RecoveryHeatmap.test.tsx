import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { changeRuntimeLocale } from '../../i18n'
import { RecoveryHeatmap } from './RecoveryHeatmap'
import type { HeatmapDay } from './recovery-center-model'

// A fixed clock so the densified grid's day keys are deterministic.
const NOW = Date.UTC(2026, 6, 6, 12, 0, 0)

const rows: HeatmapDay[] = [
  { day: '2026-07-05', failures: 3, recovered: 1, mttrSeconds: 200 },
]

describe('<RecoveryHeatmap /> drill-in', () => {
  it('renders a clickable button for a day with failures and fires onSelectDay', () => {
    const onSelectDay = vi.fn()
    render(<RecoveryHeatmap days={rows} windowDays={3} nowMs={NOW} onSelectDay={onSelectDay} />)
    const cell = screen.getByTestId('recovery-heatmap-cell-2026-07-05')
    expect(cell.tagName.toLowerCase()).toBe('button')
    fireEvent.click(cell)
    expect(onSelectDay).toHaveBeenCalledWith('2026-07-05')
  })

  it('keeps empty days in the roving grid but marks them non-actionable', () => {
    const onSelectDay = vi.fn()
    render(<RecoveryHeatmap days={rows} windowDays={3} nowMs={NOW} onSelectDay={onSelectDay} />)
    const emptyCell = screen.getByTestId('recovery-heatmap-cell-2026-07-04')
    expect(emptyCell.tagName.toLowerCase()).toBe('button')
    expect(emptyCell).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(emptyCell)
    expect(onSelectDay).not.toHaveBeenCalled()
  })

  it('exposes one tab stop and moves through the column-major grid with arrows', () => {
    render(<RecoveryHeatmap days={rows} windowDays={10} nowMs={NOW} onSelectDay={vi.fn()} />)
    const cells = screen.getAllByTestId(/recovery-heatmap-cell-/)
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1)

    const failure = screen.getByTestId('recovery-heatmap-cell-2026-07-05')
    failure.focus()
    fireEvent.keyDown(failure, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('recovery-heatmap-cell-2026-07-06'))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByTestId('recovery-heatmap-cell-2026-06-29'))
  })

  it('does not wrap focus across visual row or column boundaries', () => {
    render(<RecoveryHeatmap days={rows} windowDays={10} nowMs={NOW} onSelectDay={vi.fn()} />)
    const first = screen.getByTestId('recovery-heatmap-cell-2026-06-27')
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(first)

    const bottomOfFirstColumn = screen.getByTestId('recovery-heatmap-cell-2026-07-03')
    bottomOfFirstColumn.focus()
    fireEvent.keyDown(bottomOfFirstColumn, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(bottomOfFirstColumn)

    const finalCell = screen.getByTestId('recovery-heatmap-cell-2026-07-06')
    finalCell.focus()
    fireEvent.keyDown(finalCell, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(finalCell)
  })

  it('uses singular accessible count labels in both locales', () => {
    const singularRows: HeatmapDay[] = [
      { day: '2026-07-05', failures: 1, recovered: 1, mttrSeconds: 200 },
    ]
    const { unmount } = render(
      <RecoveryHeatmap days={singularRows} windowDays={3} nowMs={NOW} onSelectDay={vi.fn()} />,
    )
    expect(screen.getByTestId('recovery-heatmap-cell-2026-07-05'))
      .toHaveAccessibleName('2026-07-05: 1 failure, 1 recovered')
    unmount()

    try {
      changeRuntimeLocale('es')
      render(<RecoveryHeatmap days={singularRows} windowDays={3} nowMs={NOW} onSelectDay={vi.fn()} />)
      expect(screen.getByTestId('recovery-heatmap-cell-2026-07-05'))
        .toHaveAccessibleName('2026-07-05: 1 fallo, 1 recuperado')
    } finally {
      changeRuntimeLocale('en')
    }
  })

  it('renders nothing until the clock is ready', () => {
    const { container } = render(<RecoveryHeatmap days={rows} windowDays={3} nowMs={null} />)
    expect(container.querySelector('[data-testid="recovery-heatmap"]')).toBeNull()
  })
})
