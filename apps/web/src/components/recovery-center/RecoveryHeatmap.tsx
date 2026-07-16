/**
 * Recovery heatmap — a GitHub-contribution-style calendar of the last N days,
 * one cell per day colored by that day's failure/recovery outcome (gray none,
 * green all-recovered, amber partial, red unrecovered). Tells the seasonal
 * "we used to fail a lot, now we recover" story at a glance.
 *
 * Pure grid logic lives in `./helpers.ts` (`buildHeatmapCells` / `heatmapOutcome`);
 * this component is presentational and fetches nothing — `RecoveryCenterPanel`
 * passes the API rows in. When day selection is available the calendar uses a
 * single roving tab stop; arrows move through the column-major seven-day grid.
 */

import { useMemo, useRef, useState, type KeyboardEvent } from 'react'

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
  const defaultFocusIndex = useMemo(() => {
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      if ((cells[index]?.failures ?? 0) > 0) return index
    }
    return Math.max(0, cells.length - 1)
  }, [cells])
  const [focusedDay, setFocusedDay] = useState<string | null>(null)
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([])
  if (nowMs === null) return null

  const totalFailures = cells.reduce((sum, c) => sum + c.failures, 0)
  const totalRecovered = cells.reduce((sum, c) => sum + c.recovered, 0)
  const totalFailureLabel = t('recoveryCenter.heatmap.failureCount', { count: totalFailures })
  const totalRecoveredLabel = t('recoveryCenter.heatmap.recoveredCount', { count: totalRecovered })
  const rememberedFocusIndex = focusedDay === null
    ? -1
    : cells.findIndex((candidate) => candidate.day === focusedDay)
  const focusedIndex = rememberedFocusIndex >= 0 ? rememberedFocusIndex : defaultFocusIndex

  return (
    <section
      className="we-recovery-heatmap"
      data-testid="recovery-heatmap"
      aria-label={
        t('recoveryCenter.heatmap.aria', {
          days: windowDays,
          failures: totalFailureLabel,
          recovered: totalRecoveredLabel,
        })
      }
    >
      <div className="we-recovery-heatmap__head">
        <span className="section-kicker">{t('recoveryCenter.heatmap.title')}</span>
        <span className="we-recovery-heatmap__summary">
          {t('recoveryCenter.heatmap.summary', {
            failures: totalFailureLabel,
            recovered: totalRecoveredLabel,
          })}
        </span>
      </div>
      <div className="we-recovery-heatmap__grid">
        {cells.map((cell, index) => {
          const failureLabel = t('recoveryCenter.heatmap.failureCount', { count: cell.failures })
          const recoveredLabel = t('recoveryCenter.heatmap.recoveredCount', { count: cell.recovered })
          const cellTitle = t('recoveryCenter.heatmap.cell', {
            day: cell.day,
            failures: failureLabel,
            recovered: recoveredLabel,
          })
          if (onSelectDay) {
            const actionable = cell.failures > 0
            const moveFocus = (nextIndex: number) => {
              const bounded = Math.max(0, Math.min(cells.length - 1, nextIndex))
              const next = cells[bounded]
              if (!next) return
              setFocusedDay(next.day)
              cellRefs.current[bounded]?.focus()
            }
            const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
              let nextIndex: number | null = null
              const row = index % 7
              if (event.key === 'ArrowUp') nextIndex = row > 0 ? index - 1 : null
              else if (event.key === 'ArrowDown') nextIndex = row < 6 && index + 1 < cells.length ? index + 1 : null
              else if (event.key === 'ArrowLeft') nextIndex = index >= 7 ? index - 7 : null
              else if (event.key === 'ArrowRight') nextIndex = index + 7 < cells.length ? index + 7 : null
              else if (event.key === 'Home') nextIndex = 0
              else if (event.key === 'End') nextIndex = cells.length - 1
              else return
              event.preventDefault()
              if (nextIndex !== null) moveFocus(nextIndex)
            }
            return (
              <button
                key={cell.day}
                ref={(node) => { cellRefs.current[index] = node }}
                type="button"
                className={`we-recovery-heatmap__cell${actionable ? ' we-recovery-heatmap__cell--clickable' : ''}`}
                data-outcome={cell.outcome}
                data-testid={`recovery-heatmap-cell-${cell.day}`}
                title={cellTitle}
                aria-label={cellTitle}
                aria-disabled={!actionable}
                tabIndex={index === focusedIndex ? 0 : -1}
                onFocus={() => setFocusedDay(cell.day)}
                onKeyDown={onKeyDown}
                onClick={actionable ? () => onSelectDay(cell.day) : undefined}
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
        <span className="we-recovery-heatmap__legend-label">{t('recoveryCenter.heatmap.legend.less')}</span>
        <span className="we-recovery-heatmap__cell" data-outcome="none" />
        <span className="we-recovery-heatmap__cell" data-outcome="recovered" />
        <span className="we-recovery-heatmap__cell" data-outcome="partial" />
        <span className="we-recovery-heatmap__cell" data-outcome="unrecovered" />
        <span className="we-recovery-heatmap__legend-label">{t('recoveryCenter.heatmap.legend.more')}</span>
      </div>
    </section>
  )
}
