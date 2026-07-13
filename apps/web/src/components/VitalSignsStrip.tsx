/**
 * Cross-surface "vital signs" strip. Renders a `.we-ops-grid` containing
 * one card per `VitalSignsTile`. Used today by the Operations dashboard
 * (header strip, 6 read-only tiles) and the home page (4 interactive tiles
 * that navigate to other tabs on click).
 *
 * Tiles are presentational — every label, display value, severity, and
 * optional rationale comes in as a prop. The strip never owns its own data
 * fetch; the caller decides where its tile values originate.
 *
 * Click behavior: a tile with `onClick` renders as a `<button>` with focus
 * + hover state; without `onClick` it renders as a static `<section>`.
 * The button variant exists so the home page can keep its existing
 * "click to navigate" UX after migrating off the bespoke
 * `RecoveryCenterMetric` component.
 *
 * Count-up animation: a tile that supplies `numericValue: number | null`
 * opts in to a cubic-ease count-up via the shared `useAnimatedNumber`
 * hook. The visible animation targets the first numeric token in `display`,
 * not the raw metric unit, so a millisecond MTTR value formatted as
 * `1m 30s` still renders in display units. Reduced-motion users (and
 * snap-render via `numericValue: null`) skip the animation. Operations tiles
 * intentionally omit `numericValue` to preserve their current static rendering.
 */

import React from 'react'
import { useAnimatedNumber } from '../hooks/useAnimatedNumber'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'

export type VitalSignsTileSeverity = 'healthy' | 'warn' | 'unhealthy' | 'neutral' | 'info'

export type VitalSignsTile = {
  /** Lucide-react icon node (sized 14-16px). Decorative. */
  icon: React.ReactNode
  /** Pre-translated label, e.g. "Workflow success rate". */
  label: string
  /** Pre-formatted value string, e.g. "95.0%", "1m 30s", "$12.34", or "—". */
  display: string
  /** Severity-tinted left border + value color. */
  severity: VitalSignsTileSeverity
  /** Optional one-line "why this value" copy below the metric. */
  rationale?: string
  /** When set (0–100), renders the thin progress bar tinted by severity. */
  progressValue?: number | null
  /** When set, the tile renders as a `<button>` and fires this on click. */
  onClick?: () => void
  /** When set, opts the tile into a cubic-ease count-up animation. The
   *  `display` string supplies the formatting; only the numeric portion
   *  animates. Pass `null` to mean "no value yet — render `display`
   *  verbatim and skip the animation". Omit entirely for static tiles. */
  numericValue?: number | null
  /** Optional numeric series (e.g. per-day MTTR seconds, oldest-first) rendered
   *  as a tiny inline trend sparkline under the value. Needs ≥2 points; the
   *  line is green when the last point is at/below the series mean (improving),
   *  red otherwise. Omit for tiles without a trend. */
  sparkline?: number[]
  /** aria-label for the sparkline — screen readers can't read the SVG shape. */
  sparklineLabel?: string
  /** Native hover tooltip for the sparkline (e.g. the exact per-day values). */
  sparklineTitle?: string
  /** One localized accessible label per sparkline point. */
  sparklinePointLabels?: string[]
  /** Makes the sparkline a roving keyboard control without nesting it in the tile button. */
  onSelectSparklinePoint?: (index: number) => void
  /** Optional aria-label override. Defaults to the tile's `label`. */
  ariaLabel?: string
  /** Pre-translated severity word (e.g. "Healthy" / "Needs attention") announced
   *  to screen readers. The severity is otherwise conveyed by color ONLY (the
   *  card's left border + value tint), so without this a non-sighted operator
   *  can't tell a healthy metric from an unhealthy one. Use `withSeverityLabels`
   *  to populate it from the catalog. */
  severityLabel?: string
  /** Surface-specific test id (e.g. `recovery-center-metric-failures`). */
  testId?: string
}

/**
 * Decorate tiles with a localized `severityLabel` (screen-reader text for the
 * color-only severity band). The caller supplies its own `t`, keeping this
 * component presentational — it never imports the i18n module. A tile that
 * already set `severityLabel` is left untouched.
 */
export function withSeverityLabels(
  tiles: VitalSignsTile[],
  t: (key: string) => unknown,
): VitalSignsTile[] {
  return tiles.map((tile) => ({
    ...tile,
    severityLabel: tile.severityLabel ?? String(t(`vitals.severity.${tile.severity}`)),
  }))
}

export function VitalSignsStrip({
  tiles,
  ariaLabel,
  testId,
}: {
  tiles: VitalSignsTile[]
  ariaLabel?: string
  /** Default `operations-metric-strip`. Override when the surface needs
   *  a distinct testid (e.g. home's strip might want `home-vital-signs`). */
  testId?: string
}) {
  return (
    <div
      className="we-ops-grid"
      aria-label={ariaLabel}
      data-testid={testId ?? 'operations-metric-strip'}
    >
      {tiles.map((tile, idx) => (
        <VitalSignsTileCard key={tile.testId ?? `${tile.label}-${idx}`} tile={tile} />
      ))}
    </div>
  )
}

function VitalSignsTileCard({ tile }: { tile: VitalSignsTile }) {
  const isClickable = typeof tile.onClick === 'function'
  const hasInteractiveSparkline = Boolean(tile.sparkline && tile.onSelectSparklinePoint)
  const className = [
    'panel-card',
    'we-ops-metric-card',
    `we-ops-metric-card--${tile.severity}`,
    isClickable && !hasInteractiveSparkline ? 'we-ops-metric-card--button' : '',
    isClickable && hasInteractiveSparkline ? 'we-ops-metric-card--split-action' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const animatedValue = useTileDisplayValue(tile.numericValue, tile.display)

  const primaryBody = (
    <>
      <div className="we-ops-metric-card__head">
        <span className="we-ops-metric-card__icon" aria-hidden="true">{tile.icon}</span>
        <span className="section-kicker we-ops-metric-card__label">{tile.label}</span>
      </div>
      <div className="we-ops-metric-card__value">{animatedValue}</div>
      {/* Screen-reader-only severity word — the visible severity is color-only
          (border + value tint). Read after the value: "…, 95.0%, Healthy". On
          the clickable variant the button's aria-label carries it instead (an
          aria-label overrides inner content), so this span only feeds the static
          section variant. */}
      {tile.severityLabel && <span className="we-sr-only">{tile.severityLabel}</span>}
      {typeof tile.progressValue === 'number' && tile.progressValue !== null && (
        <div className="we-ops-progress" role="presentation">
          <span className="we-ops-progress__rail" />
          <span
            className={`we-ops-progress__fill we-ops-progress__fill--${tile.severity}`}
            style={{ width: `${Math.max(0, Math.min(100, tile.progressValue))}%` }}
          />
        </div>
      )}
      {tile.rationale && (
        <p className="helper-text we-ops-metric-card__rationale">{tile.rationale}</p>
      )}
    </>
  )

  const sparkline = tile.sparkline && (
    <Sparkline
      points={tile.sparkline}
      ariaLabel={tile.sparklineLabel}
      title={tile.sparklineTitle}
      pointLabels={tile.sparklinePointLabels}
      onSelectPoint={tile.onSelectSparklinePoint}
    />
  )

  if (isClickable && hasInteractiveSparkline) {
    return (
      <section className={className}>
        <button
          type="button"
          className="we-ops-metric-card__main-action"
          onClick={tile.onClick}
          aria-label={clickableTileAriaLabel(tile)}
          data-testid={tile.testId}
        >
          {primaryBody}
        </button>
        {sparkline}
      </section>
    )
  }

  const body = <>{primaryBody}{sparkline}</>

  if (isClickable) {
    return (
      <button
        type="button"
        className={className}
        onClick={tile.onClick}
        aria-label={clickableTileAriaLabel(tile)}
        data-testid={tile.testId}
      >
        {body}
      </button>
    )
  }

  return (
    <section
      className={className}
      aria-label={tile.ariaLabel}
      data-testid={tile.testId}
    >
      {body}
    </section>
  )
}

/**
 * Tiny inline trend sparkline. Renders an 80×16 polyline over `points`
 * (oldest-first) in standard orientation — a HIGHER value sits higher on the
 * chart (the `1 - normalized` term flips SVG's top-down Y so the line reads
 * naturally). Direction is conveyed by COLOR, not slope: green when the last
 * point is at/below the series mean (improving — for MTTR, lower is better),
 * red otherwise. Returns null below 2 points — a single dot tells no story.
 * Pure SVG, no animation, so reduced-motion is a non-issue.
 */
export function Sparkline({
  points,
  ariaLabel,
  title,
  pointLabels,
  onSelectPoint,
}: {
  points: number[]
  ariaLabel?: string
  title?: string
  pointLabels?: string[]
  onSelectPoint?: (index: number) => void
}) {
  const [activeIndex, setActiveIndex] = React.useState(() => Math.max(0, points.length - 1))
  const pointRefs = React.useRef<Array<SVGRectElement | null>>([])
  if (points.length < 2) return null
  const width = 80
  const height = 16
  const pad = 1.5
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const stepX = (width - pad * 2) / (points.length - 1)
  const pointCoords = points.map((value, i) => {
      const x = pad + i * stepX
      const y = pad + (height - pad * 2) * (1 - (value - min) / range)
      return { x, y }
    })
  const coords = pointCoords
    .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')
  const mean = points.reduce((sum, value) => sum + value, 0) / points.length
  const trend = points[points.length - 1] <= mean ? 'down' : 'up'
  // Without an explicit label the sparkline is a supplementary decoration next
  // to a tile that already carries its own text + numeric value, so mark it
  // decorative (`aria-hidden`, no `role="img"`) rather than leaving an unnamed
  // image in the accessibility tree. With a label it stays an announced image.
  const interactive = typeof onSelectPoint === 'function'
  const decorative = !interactive && (ariaLabel === undefined || ariaLabel === '')
  const safeActiveIndex = Math.min(activeIndex, points.length - 1)
  const focusPoint = (index: number) => {
    const next = Math.max(0, Math.min(points.length - 1, index))
    setActiveIndex(next)
    pointRefs.current[next]?.focus()
  }
  const onPointKeyDown = (event: React.KeyboardEvent<SVGRectElement>, index: number) => {
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        focusPoint(index - 1)
        break
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        focusPoint(index + 1)
        break
      case 'Home':
        event.preventDefault()
        focusPoint(0)
        break
      case 'End':
        event.preventDefault()
        focusPoint(points.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        onSelectPoint?.(index)
        break
    }
  }
  return (
    <svg
      className={`we-sparkline we-sparkline--${trend}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role={decorative ? undefined : interactive ? 'group' : 'img'}
      aria-label={ariaLabel}
      aria-hidden={decorative || undefined}
      preserveAspectRatio="none"
      data-testid="vitals-sparkline"
      data-trend={trend}
    >
      {title && <title>{title}</title>}
      <polyline points={coords} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {interactive && points.map((value, index) => {
        const { x, y } = pointCoords[index] ?? { x: pad, y: height / 2 }
        const hitWidth = index === 0 || index === points.length - 1 ? stepX / 2 + pad : stepX
        const hitX = index === 0 ? 0 : index === points.length - 1 ? x - stepX / 2 : x - stepX / 2
        const pointLabel = pointLabels?.[index] ?? `${index + 1}: ${value}`
        return (
          <g key={index}>
            <rect
              ref={(node) => { pointRefs.current[index] = node }}
              className="we-sparkline__hit-target"
              x={hitX}
              y={0}
              width={hitWidth}
              height={height}
              role="button"
              tabIndex={index === safeActiveIndex ? 0 : -1}
              aria-label={pointLabel}
              data-testid={`vitals-sparkline-point-${index}`}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => onPointKeyDown(event, index)}
              onClick={() => onSelectPoint(index)}
            >
              <title>{pointLabel}</title>
            </rect>
            <circle
              className="we-sparkline__focus-dot"
              cx={x}
              cy={y}
              r="2.5"
              aria-hidden="true"
            />
          </g>
        )
      })}
    </svg>
  )
}

function clickableTileAriaLabel(tile: VitalSignsTile): string {
  const base = tile.ariaLabel ?? [tile.label, tile.display].filter(Boolean).join(', ')
  return [base, tile.severityLabel].filter(Boolean).join(', ')
}

/**
 * Returns the value string to render. When the tile opted-in via
 * `numericValue`, runs the count-up animation and formats the live value
 * with the SAME leading / trailing tokens the `display` string supplies
 * (so "$12.34" / "98%" / "—" all stay stable while the integer animates).
 * Otherwise returns `display` verbatim.
 */
function useTileDisplayValue(numericValue: number | undefined | null, display: string): string {
  const snap = usePrefersReducedMotion()
  const optedIn = numericValue !== undefined && numericValue !== null && Number.isFinite(numericValue)
  const displayTarget = optedIn ? parseDisplayNumber(display)?.value : null
  const target = displayTarget ?? 0
  const animated = useAnimatedNumber(target, 600, snap || !optedIn || displayTarget === null)
  if (!optedIn || displayTarget === null) return display
  return formatAnimatedValue(animated, display)
}

/** Replicates the home-page count-up formatter: keeps "$" / "%" / "m"
 *  suffixes stable while letting the integer animate. "—" is the absence
 *  sentinel; never animate. */
function formatAnimatedValue(animated: number, display: string): string {
  const parts = parseDisplayNumber(display)
  if (!parts) return display
  const rounded = parts.decimals > 0 ? animated.toFixed(parts.decimals) : Math.round(animated).toString()
  return `${parts.leading}${rounded}${parts.trailing}`
}

function parseDisplayNumber(display: string): {
  leading: string
  value: number
  decimals: number
  trailing: string
} | null {
  if (display === '—') return null
  const match = display.match(/^([^0-9-]*)(-?\d+(?:\.\d+)?)(.*)$/)
  if (!match) return null
  const leading = match[1] ?? ''
  const numeric = match[2]
  const trailing = match[3] ?? ''
  if (!numeric) return null
  const value = Number(numeric)
  if (!Number.isFinite(value)) return null
  const decimals = numeric.includes('.') ? numeric.split('.')[1]?.length ?? 0 : 0
  return { leading, value, decimals, trailing }
}
