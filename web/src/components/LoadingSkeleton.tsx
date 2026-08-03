/**
 * Loading placeholder for list/panel fetches — shimmer rows that approximate
 * the final content height, instead of a bare "Loading…" line (which causes a
 * layout jump when real rows arrive and reads as empty space).
 *
 * Carries a polite live-region label so screen readers announce the load; the
 * shimmer rows themselves are aria-hidden. Pass `label` localized via t().
 *
 * Used by the list panels (members / dead-letters / audit / alert policies / …).
 */

import type { ReactNode } from 'react'

export function LoadingSkeleton({
  rows = 3,
  label,
  testId,
}: {
  rows?: number
  label?: string
  testId?: string
}): ReactNode {
  return (
    <div
      className="we-skeleton"
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid={testId ?? 'loading-skeleton'}
    >
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="we-skeleton__row" aria-hidden="true">
          <span className="we-skeleton__line" />
          <span className="we-skeleton__line we-skeleton__line--short" />
        </div>
      ))}
    </div>
  )
}
