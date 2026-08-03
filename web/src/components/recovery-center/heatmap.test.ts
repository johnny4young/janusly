import { describe, expect, it } from 'vitest'

import { buildHeatmapCells, computeStreaks, heatmapOutcome, type HeatmapCell, type HeatmapDay } from './recovery-center-model'

describe('heatmapOutcome', () => {
  it('classifies each band', () => {
    expect(heatmapOutcome(0, 0)).toBe('none')
    expect(heatmapOutcome(3, 3)).toBe('recovered')
    expect(heatmapOutcome(3, 1)).toBe('partial')
    expect(heatmapOutcome(3, 0)).toBe('unrecovered')
  })
})

describe('buildHeatmapCells', () => {
  // 2026-07-06T12:00:00Z → UTC "today" is 2026-07-06.
  const NOW = Date.UTC(2026, 6, 6, 12, 0, 0)

  it('densifies sparse rows into a contiguous oldest→newest grid', () => {
    const rows: HeatmapDay[] = [
      { day: '2026-07-05', failures: 2, recovered: 2, mttrSeconds: 120 },
      { day: '2026-07-06', failures: 4, recovered: 1, mttrSeconds: 300 },
    ]
    const cells = buildHeatmapCells(rows, 3, NOW)
    expect(cells).toHaveLength(3)
    expect(cells.map((c) => c.day)).toEqual(['2026-07-04', '2026-07-05', '2026-07-06'])
    // 07-04 missing → zero/none; 07-05 all recovered → green; 07-06 partial → amber.
    expect(cells[0]).toMatchObject({ failures: 0, recovered: 0, outcome: 'none' })
    expect(cells[1]).toMatchObject({ failures: 2, recovered: 2, outcome: 'recovered' })
    expect(cells[2]).toMatchObject({ failures: 4, recovered: 1, outcome: 'partial' })
  })

  it('clamps the window to 1..90 days', () => {
    expect(buildHeatmapCells([], 0, NOW)).toHaveLength(1)
    expect(buildHeatmapCells([], 1000, NOW)).toHaveLength(90)
  })

  it('marks a fully-unrecovered day red', () => {
    const cells = buildHeatmapCells(
      [{ day: '2026-07-06', failures: 5, recovered: 0, mttrSeconds: 0 }],
      1,
      NOW,
    )
    expect(cells[0].outcome).toBe('unrecovered')
  })
})

describe('computeStreaks', () => {
  const cell = (failures: number, recovered: number): HeatmapCell => ({
    day: '2026-07-06',
    failures,
    recovered,
    outcome: heatmapOutcome(failures, recovered),
  })

  it('returns zero current streak when the newest day still has a failure', () => {
    expect(computeStreaks([cell(0, 0), cell(1, 0)])).toEqual({ current: 0, longest: 0 })
  })

  it('counts recovered-only and fully recovered days as clean', () => {
    expect(computeStreaks([cell(0, 2), cell(2, 2), cell(0, 0)])).toEqual({ current: 3, longest: 3 })
  })

  it('resets across a partial day while retaining the longest run', () => {
    expect(computeStreaks([
      cell(0, 0),
      cell(1, 1),
      cell(2, 1),
      cell(0, 0),
      cell(3, 3),
      cell(0, 0),
    ])).toEqual({ current: 3, longest: 3 })
  })

  it('does not count leading densified days before the first observed activity', () => {
    expect(computeStreaks([
      cell(0, 0),
      cell(0, 0),
      cell(1, 1),
      cell(0, 0),
    ])).toEqual({ current: 2, longest: 2 })
  })
})
