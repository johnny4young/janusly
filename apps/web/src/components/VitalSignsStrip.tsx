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
  const className = [
    'panel-card',
    'we-ops-metric-card',
    `we-ops-metric-card--${tile.severity}`,
    isClickable ? 'we-ops-metric-card--button' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const animatedValue = useTileDisplayValue(tile.numericValue, tile.display)

  const body = (
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

  if (isClickable) {
    return (
      <button
        type="button"
        className={className}
        onClick={tile.onClick}
        aria-label={tile.ariaLabel ?? [tile.label, tile.display, tile.severityLabel].filter(Boolean).join(', ')}
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
