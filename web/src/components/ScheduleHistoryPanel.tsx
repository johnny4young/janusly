/**
 * Schedule observability panel — the "Schedule" tab content in the workflow
 * detail / Inspector right panel. Renders a GitHub-style heatmap of scheduled
 * fire activity (day-of-week × hour-of-day, UTC) as a HAND-WRITTEN SVG (no
 * `recharts` / charting dependency) plus a next-N-fires preview per schedule
 * entry computed server-side from `cron-parser`.
 *
 * Each cell is shaded by fire volume; the success/fail split rides in the
 * cell's `<title>` tooltip and tints the cell toward green (mostly success)
 * or red (mostly fail). Empty history renders the grid skeleton with a
 * "no fires yet" empty state so a never-fired schedule still reads.
 *
 * Multi-tenant: the single fetch carries the org-id header (via `api()`); the
 * server gates the workflow lookup to the caller's org. Read-only (viewer
 * role) — no mutation, so no `bumpPlatformVersion()`.
 *
 * Anomaly overlay: cells whose `anomaly` flag is set (failure rate diverging
 * above the schedule baseline — scored server-side in `schedule-history.ts`)
 * get a red corner dot, a tooltip note, and a legend entry. Healthy and
 * uniformly-failing schedules light up nothing.
 *
 * Used by `RightPanel.tsx` (Inspector tab, mounted alongside the SLO +
 * metadata panels).
 */

import { useEffect, useMemo, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, useT } from '../i18n'

export type ScheduleHistoryPanelProps = {
  /** Optional explicit workflowId. When omitted, the panel pulls the current
   *  workflow id from the store — matches the WorkflowSloPanel pattern. */
  workflowId?: string | undefined
}

type HeatmapCell = {
  dayOfWeek: number
  hour: number
  total: number
  success: number
  fail: number
  anomaly: boolean
}

type ScheduleHistoryResponse = {
  workflowId: string
  windowDays: number
  rowCap: number
  capped: boolean
  heatmap: {
    cells: HeatmapCell[]
    totalFires: number
    totalSuccess: number
    totalFail: number
    timezone: string
  }
  schedules: Array<{
    nodeId: string
    cronExpression: string
    enabled: boolean
    lastRunAt: string | null
    lastRunId: string | null
    nextFires: string[]
  }>
}

// Day labels are derived from the locale at render time (see `dayLabels`).
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const

const CELL = 14
const CELL_GAP = 3
const ROW_LABEL_W = 34
const COL_LABEL_H = 16

/**
 * Map a cell's fire count + success ratio to a fill class. Empty cells get
 * the neutral track; populated cells tint toward success (green) or fail
 * (red) with intensity stepped by volume. Pure — no hooks.
 */
function cellClass(cell: HeatmapCell | undefined, maxTotal: number): string {
  if (!cell || cell.total === 0) return 'we-schedule-heatmap__cell--empty'
  const ratio = maxTotal > 0 ? cell.total / maxTotal : 0
  const intensity = ratio > 0.66 ? 3 : ratio > 0.33 ? 2 : 1
  // Tint by outcome: any failure pulls the cell toward the danger ramp;
  // an all-success cell sits on the success ramp.
  const tone = cell.fail > 0 ? (cell.fail >= cell.success ? 'fail' : 'mixed') : 'success'
  return `we-schedule-heatmap__cell--${tone}-${intensity}`
}

export function ScheduleHistoryPanel({ workflowId: explicit }: ScheduleHistoryPanelProps = {}) {
  const { t } = useT()
  const storeWorkflowId = useWorkflowStore((s) => s.currentWorkflowId)
  const storeWorkflowSaved = useWorkflowStore((s) => s.currentWorkflowSaved)
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  // With no explicit id this panel targets the current draft — but only once
  // it has been saved. An unsaved draft has no server row, so the lookup would
  // 404; an explicit id always resolves.
  const workflowId = explicit ?? (storeWorkflowSaved ? storeWorkflowId : undefined)

  const [data, setData] = useState<ScheduleHistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    if (!workflowId) return
    let cancelled = false
    setLoading(true)
    setErrored(false)
    api(`/workflows/${encodeURIComponent(workflowId)}/schedule-history`)
      .then((payload) => {
        if (cancelled) return
        setData(payload as ScheduleHistoryResponse)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setErrored(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, platformVersion])

  const locale = getResolvedLocale()
  const dayLabels = useMemo(() => {
    // Localized short weekday names (Sun..Sat) via Intl — respects the UI
    // language without hardcoding English. `timeZone: 'UTC'` is load-bearing:
    // the grid buckets fires by UTC day-of-week (and the hour labels are raw
    // UTC), so the row labels must read the reference instant in UTC too —
    // otherwise a negative-offset browser would shift every label back a day
    // and mislabel the rows against their own data.
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
    // 2024-01-07 is a Sunday (UTC); +d days walks the week.
    return DAYS.map((d) => fmt.format(new Date(Date.UTC(2024, 0, 7 + d))))
  }, [locale])

  const cellIndex = useMemo(() => {
    const map = new Map<number, HeatmapCell>()
    for (const cell of data?.heatmap.cells ?? []) {
      map.set(cell.dayOfWeek * 24 + cell.hour, cell)
    }
    return map
  }, [data])

  const maxTotal = useMemo(() => {
    let max = 0
    for (const cell of data?.heatmap.cells ?? []) {
      if (cell.total > max) max = cell.total
    }
    return max
  }, [data])

  if (!workflowId) return null

  const svgWidth = ROW_LABEL_W + HOURS.length * (CELL + CELL_GAP)
  const svgHeight = COL_LABEL_H + DAYS.length * (CELL + CELL_GAP)
  const fires = data?.heatmap.totalFires ?? 0

  return (
    <section className="we-card we-schedule-panel" aria-labelledby="we-schedule-panel-title">
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('scheduleHistory.kicker')}</div>
          <h3 id="we-schedule-panel-title" className="section-title">{t('scheduleHistory.title')}</h3>
        </div>
        <CalendarClock size={18} aria-hidden="true" />
      </div>
      <p className="helper-text">{t('scheduleHistory.description')}</p>

      {loading && <p className="helper-text">{t('scheduleHistory.loading')}</p>}
      {errored && !loading && <p className="helper-text helper-text--error" role="alert">{t('scheduleHistory.error')}</p>}

      {!loading && !errored && data && (
        <>
          <div className="we-schedule-summary">
            <span className="we-pill" data-tone="neutral">
              {t('scheduleHistory.summary.window', { days: data.windowDays })}
            </span>
            <span className="we-pill" data-tone="neutral">
              {t('scheduleHistory.summary.fires', { count: fires })}
            </span>
            <span className="we-pill" data-tone="success">
              {t('scheduleHistory.summary.success', { count: data.heatmap.totalSuccess })}
            </span>
            <span className="we-pill" data-tone="warning">
              {t('scheduleHistory.summary.fail', { count: data.heatmap.totalFail })}
            </span>
            <span className="we-pill" data-tone="neutral" title={t('scheduleHistory.timezoneHint')}>
              {t('scheduleHistory.summary.timezone', { zone: data.heatmap.timezone })}
            </span>
          </div>

          {fires === 0 ? (
            <p className="helper-text we-schedule-empty">{t('scheduleHistory.empty')}</p>
          ) : null}

          {/* Hand-written SVG heatmap. role=img + aria-label gives screen
              readers the headline; per-cell <title> carries the breakdown. */}
          <div className="we-schedule-heatmap-scroll">
            <svg
              className="we-schedule-heatmap"
              width={svgWidth}
              height={svgHeight}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              role="img"
              aria-label={t('scheduleHistory.aria.grid', { count: fires })}
            >
              {/* Hour column labels — every 3rd hour to avoid clutter. */}
              {HOURS.map((hour) =>
                hour % 3 === 0 ? (
                  <text
                    key={`hl-${hour}`}
                    className="we-schedule-heatmap__axis"
                    x={ROW_LABEL_W + hour * (CELL + CELL_GAP)}
                    y={COL_LABEL_H - 5}
                  >
                    {String(hour).padStart(2, '0')}
                  </text>
                ) : null,
              )}
              {/* Day rows. */}
              {DAYS.map((day, rowIdx) => (
                <g key={`row-${day}`}>
                  <text
                    className="we-schedule-heatmap__axis"
                    x={0}
                    y={COL_LABEL_H + rowIdx * (CELL + CELL_GAP) + CELL - 3}
                  >
                    {dayLabels[rowIdx]}
                  </text>
                  {HOURS.map((hour) => {
                    const cell = cellIndex.get(day * 24 + hour)
                    const x = ROW_LABEL_W + hour * (CELL + CELL_GAP)
                    const y = COL_LABEL_H + rowIdx * (CELL + CELL_GAP)
                    const baseTitle = cell && cell.total > 0
                      ? (t('scheduleHistory.cell.tooltip', {
                          day: dayLabels[rowIdx],
                          hour: String(hour).padStart(2, '0'),
                          total: cell.total,
                          success: cell.success,
                          fail: cell.fail,
                        }))
                      : (t('scheduleHistory.cell.empty', {
                          day: dayLabels[rowIdx],
                          hour: String(hour).padStart(2, '0'),
                        }))
                    // Anomalous cells append a note so the red dot's meaning
                    // is reachable via the same hover tooltip.
                    const title = cell?.anomaly
                      ? `${baseTitle}\n${t('scheduleHistory.cell.anomaly')}`
                      : baseTitle
                    return (
                      <g key={`c-${day}-${hour}`}>
                        <rect
                          className={`we-schedule-heatmap__cell ${cellClass(cell, maxTotal)}`}
                          x={x}
                          y={y}
                          width={CELL}
                          height={CELL}
                          rx={2}
                        >
                          <title>{title}</title>
                        </rect>
                        {/* Anomaly overlay: a red dot on the cell's top-right
                            corner when the slot's failure rate diverges above
                            the schedule baseline. Decorative (the meaning rides
                            the rect's title); pointer-events:none keeps the
                            rect tooltip on hover. */}
                        {cell?.anomaly && (
                          <circle
                            className="we-schedule-heatmap__anomaly-dot"
                            cx={x + CELL - 3}
                            cy={y + 3}
                            r={2.5}
                            aria-hidden="true"
                          />
                        )}
                      </g>
                    )
                  })}
                </g>
              ))}
            </svg>
          </div>

          {data.capped && (
            <p className="helper-text">{t('scheduleHistory.cappedNote', { cap: data.rowCap })}</p>
          )}

          {/* Legend. */}
          <div className="we-schedule-legend">
            <span className="we-schedule-legend__label">{t('scheduleHistory.legend.less')}</span>
            <span className="we-schedule-heatmap__cell we-schedule-heatmap__cell--empty we-schedule-legend__swatch" />
            <span className="we-schedule-heatmap__cell we-schedule-heatmap__cell--success-1 we-schedule-legend__swatch" />
            <span className="we-schedule-heatmap__cell we-schedule-heatmap__cell--success-2 we-schedule-legend__swatch" />
            <span className="we-schedule-heatmap__cell we-schedule-heatmap__cell--success-3 we-schedule-legend__swatch" />
            <span className="we-schedule-legend__label">{t('scheduleHistory.legend.more')}</span>
            <span className="we-schedule-heatmap__cell we-schedule-heatmap__cell--fail-2 we-schedule-legend__swatch we-schedule-legend__swatch--gap" />
            <span className="we-schedule-legend__label">{t('scheduleHistory.legend.fail')}</span>
            <span className="we-schedule-legend__anomaly-dot we-schedule-legend__swatch--gap" aria-hidden="true" />
            <span className="we-schedule-legend__label">{t('scheduleHistory.legend.anomaly')}</span>
          </div>

          {/* Next-fires preview per schedule entry. */}
          <div className="we-schedule-upcoming">
            <h4 className="we-schedule-upcoming__title">{t('scheduleHistory.upcoming.title')}</h4>
            {data.schedules.length === 0 ? (
              <p className="helper-text">{t('scheduleHistory.upcoming.none')}</p>
            ) : (
              data.schedules.map((schedule) => (
                <div key={schedule.nodeId} className="we-schedule-entry list-card">
                  <div className="split-row" style={{ width: '100%' }}>
                    <strong className="mono">{schedule.nodeId}</strong>
                    <span className="we-pill" data-tone={schedule.enabled ? 'success' : 'neutral'}>
                      {schedule.enabled
                        ? (t('scheduleHistory.entry.enabled'))
                        : (t('scheduleHistory.entry.disabled'))}
                    </span>
                  </div>
                  <code className="we-schedule-entry__cron">{schedule.cronExpression}</code>
                  {schedule.lastRunAt && (
                    <span className="helper-text">
                      {t('scheduleHistory.entry.lastFired')}: {new Date(schedule.lastRunAt).toLocaleString(locale)}
                    </span>
                  )}
                  {schedule.enabled ? (
                    schedule.nextFires.length > 0 ? (
                      <ul className="we-schedule-entry__fires">
                        {schedule.nextFires.map((iso) => (
                          <li key={iso}>{new Date(iso).toLocaleString(locale)}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="helper-text">{t('scheduleHistory.entry.noPreview')}</span>
                    )
                  ) : (
                    <span className="helper-text">{t('scheduleHistory.entry.pausedPreview')}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  )
}
