import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RecoveryHeatmap } from './RecoveryHeatmap'

const NOW = Date.UTC(2026, 6, 6, 12, 0, 0)

describe('<RecoveryHeatmap /> keyboard exploration in Chromium', () => {
  it('moves in the rendered seven-row direction and activates only failure days', () => {
    const onSelectDay = vi.fn()
    render(
      <RecoveryHeatmap
        days={[
          { day: '2026-06-29', failures: 1, recovered: 1, mttrSeconds: 120 },
          { day: '2026-07-06', failures: 1, recovered: 1, mttrSeconds: 90 },
        ]}
        windowDays={10}
        nowMs={NOW}
        onSelectDay={onSelectDay}
      />,
    )

    const latest = screen.getByTestId('recovery-heatmap-cell-2026-07-06')
    latest.focus()
    fireEvent.keyDown(latest, { key: 'ArrowLeft' })
    const previousColumn = screen.getByTestId('recovery-heatmap-cell-2026-06-29')
    expect(document.activeElement).toBe(previousColumn)
    fireEvent.click(previousColumn)
    expect(onSelectDay).toHaveBeenCalledWith('2026-06-29')

    const empty = screen.getByTestId('recovery-heatmap-cell-2026-06-30')
    expect(empty).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(empty)
    expect(onSelectDay).toHaveBeenCalledOnce()
  })
})
