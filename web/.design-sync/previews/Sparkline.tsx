import { Sparkline } from '@janusly/web'

/**
 * Inline trend line for tiles and summary cards. Needs at least two points.
 *
 * **The colour rule is lower-is-better**: the line is green when the last
 * point sits at or below the series mean (improving) and red otherwise. That
 * makes it right for MTTR, queue depth, and latency — and wrong for a metric
 * where higher is better, which would read inverted.
 */

/** MTTR coming down — the improving case, rendered green. */
export function Improving() {
  return (
    <Sparkline
      points={[1450, 1380, 1290, 1120, 980, 870, 760, 640, 520, 410]}
      title="Median time to recovery, last 10 days"
      ariaLabel="Recovery time falling from 1450 to 410 seconds over ten days"
    />
  )
}

/** Queue depth climbing — the degrading case, rendered red. */
export function Degrading() {
  return (
    <Sparkline
      points={[8, 11, 9, 14, 18, 22, 27, 34, 41, 52]}
      title="Queue depth, last 10 hours"
      ariaLabel="Queue depth rising from 8 to 52 waiting jobs"
    />
  )
}

/** Noisy but flat — no real movement to read into it. */
export function Volatile() {
  return (
    <Sparkline
      points={[62, 78, 55, 81, 49, 74, 58, 83, 51, 69]}
      title="Queue depth, last 10 hours"
      ariaLabel="Queue depth oscillating between 49 and 83"
    />
  )
}

/** The two-point minimum, as a compact tile renders it. */
export function ShortSeries() {
  return <Sparkline points={[27, 12]} title="Open incidents this week" />
}
