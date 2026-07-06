import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RecoveryHeatmap } from './RecoveryHeatmap'
import type { HeatmapDay } from './helpers'

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

  it('leaves empty days inert (non-button) and unclickable', () => {
    const onSelectDay = vi.fn()
    render(<RecoveryHeatmap days={rows} windowDays={3} nowMs={NOW} onSelectDay={onSelectDay} />)
    const emptyCell = screen.getByTestId('recovery-heatmap-cell-2026-07-04')
    expect(emptyCell.tagName.toLowerCase()).toBe('div')
    fireEvent.click(emptyCell)
    expect(onSelectDay).not.toHaveBeenCalled()
  })

  it('renders nothing until the clock is ready', () => {
    const { container } = render(<RecoveryHeatmap days={rows} windowDays={3} nowMs={null} />)
    expect(container.querySelector('[data-testid="recovery-heatmap"]')).toBeNull()
  })
})
