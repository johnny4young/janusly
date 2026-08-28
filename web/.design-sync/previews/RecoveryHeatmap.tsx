import { RecoveryHeatmap } from '@janusly/web'

/**
 * Failure-and-recovery density over a rolling window. A day's colour band
 * comes from its failure/recovery ratio — fully recovered, partially
 * recovered, or unrecovered — and only days with failures are clickable.
 *
 * `nowMs` anchors the window, so it is passed explicitly rather than read
 * from the clock; these previews pin it for a stable render.
 */

// 2026-08-27T00:00:00Z — fixed so the grid does not drift between captures.
const NOW_MS = 1787788800000

/** Build a window ending at NOW_MS, newest day last. */
function windowOf(rows: Array<[number, number, number]>) {
  const DAY = 86400000
  return rows.map(([failures, recovered, mttrSeconds], i) => ({
    day: new Date(NOW_MS - (rows.length - 1 - i) * DAY).toISOString().slice(0, 10),
    failures,
    recovered,
    mttrSeconds,
  }))
}

/** A good month: a few incidents, all of them recovered. */
export function MostlyRecovered() {
  return (
    <RecoveryHeatmap
      windowDays={14}
      nowMs={NOW_MS}
      days={windowOf([
        [0, 0, 0], [0, 0, 0], [2, 2, 340], [0, 0, 0], [1, 1, 120], [0, 0, 0], [0, 0, 0],
        [3, 3, 610], [0, 0, 0], [0, 0, 0], [1, 1, 95], [0, 0, 0], [0, 0, 0], [0, 0, 0],
      ])}
    />
  )
}

/** A rough stretch — the three outcome bands side by side. */
export function MixedOutcomes() {
  return (
    <RecoveryHeatmap
      windowDays={14}
      nowMs={NOW_MS}
      days={windowOf([
        [0, 0, 0], [4, 4, 300], [7, 3, 1450], [9, 0, 0], [5, 2, 980], [2, 2, 210], [0, 0, 0],
        [11, 4, 2100], [6, 6, 420], [0, 0, 0], [3, 0, 0], [1, 1, 60], [0, 0, 0], [2, 1, 780],
      ])}
    />
  )
}

/** Nothing failed in the window — the empty grid. */
export function QuietWindow() {
  return (
    <RecoveryHeatmap
      windowDays={14}
      nowMs={NOW_MS}
      days={windowOf(Array.from({ length: 14 }, () => [0, 0, 0] as [number, number, number]))}
    />
  )
}
