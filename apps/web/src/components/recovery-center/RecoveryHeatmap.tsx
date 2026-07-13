/**
 * Recovery heatmap — a GitHub-contribution-style calendar of the last N days,
 * one cell per day colored by that day's failure/recovery outcome (gray none,
 * green all-recovered, amber partial, red unrecovered). Tells the seasonal
 * "we used to fail a lot, now we recover" story at a glance.
 *
 * Pure grid logic lives in `./helpers.ts` (`buildHeatmapCells` / `heatmapOutcome`);
 * this component is presentational and fetches nothing — `RecoveryCenterPanel`
 * passes the API rows in. Cells are decorative (`title` hover for sighted users);
 * the accessible summary rides the container's `aria-label`.
 */

import { useMemo } from 'react'

import { useT } from '../../i18n'
import { buildHeatmapCells, type HeatmapCell, type HeatmapDay } from './helpers'

export function RecoveryHeatmap({
  days,
  cells: providedCells,
  windowDays,
  nowMs,
  onSelectDay,
}: {
  days: HeatmapDay[]
  /** Reuse a parent-owned densified grid when another hero signal needs it. */
  cells?: HeatmapCell[]
  windowDays: number
  nowMs: number | null
  /** Drill into one day's failures. Only days WITH failures are clickable. */
  onSelectDay?: (day: string) => void
}) {
  const { t } = useT()
  const cells = useMemo(
    () => providedCells ?? buildHeatmapCells(days, windowDays, nowMs ?? 0),
    [days, providedCells, windowDays, nowMs],
  )
  if (nowMs === null) return null

  const totalFailures = cells.reduce((sum, c) => sum + c.failures, 0)
  const totalRecovered = cells.reduce((sum, c) => sum + c.recovered, 0)

  return (
    <section
      className="we-recovery-heatmap"
      data-testid="recovery-heatmap"
      aria-label={
        t('recoveryCenter.heatmap.aria', {
          days: windowDays,
          failures: totalFailures,
          recovered: totalRecovered,
        }) as string
      }
    >
      <div className="we-recovery-heatmap__head">
        <span className="section-kicker">{t('recoveryCenter.heatmap.title') as string}</span>
        <span className="we-recovery-heatmap__summary">
          {t('recoveryCenter.heatmap.summary', {
            failures: totalFailures,
            recovered: totalRecovered,
          }) as string}
        </span>
      </div>
      <div className="we-recovery-heatmap__grid" role="presentation">
        {cells.map((cell) => {
          const cellTitle = t('recoveryCenter.heatmap.cell', {
            day: cell.day,
            failures: cell.failures,
            recovered: cell.recovered,
          }) as string
          // Only days with failures are drillable; empty days stay inert.
          if (onSelectDay && cell.failures > 0) {
            return (
              <button
                key={cell.day}
                type="button"
                className="we-recovery-heatmap__cell we-recovery-heatmap__cell--clickable"
                data-outcome={cell.outcome}
                data-testid={`recovery-heatmap-cell-${cell.day}`}
                title={cellTitle}
                aria-label={cellTitle}
                onClick={() => onSelectDay(cell.day)}
              />
            )
          }
          return (
            <div
              key={cell.day}
              className="we-recovery-heatmap__cell"
              data-outcome={cell.outcome}
              data-testid={`recovery-heatmap-cell-${cell.day}`}
              title={cellTitle}
            />
          )
        })}
      </div>
      <div className="we-recovery-heatmap__legend" aria-hidden="true">
        <span className="we-recovery-heatmap__legend-label">{t('recoveryCenter.heatmap.legend.less') as string}</span>
        <span className="we-recovery-heatmap__cell" data-outcome="none" />
        <span className="we-recovery-heatmap__cell" data-outcome="recovered" />
        <span className="we-recovery-heatmap__cell" data-outcome="partial" />
        <span className="we-recovery-heatmap__cell" data-outcome="unrecovered" />
        <span className="we-recovery-heatmap__legend-label">{t('recoveryCenter.heatmap.legend.more') as string}</span>
      </div>
    </section>
  )
}
