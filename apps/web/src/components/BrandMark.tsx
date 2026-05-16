/**
 * Janusly brand mark — cobalt→cyan gradient rounded square with the 3-node
 * DAG glyph (two top circles + one bottom apex + a V-path connecting them).
 *
 * Used in the topbar, sidebar workflow card, user-menu identity strip, and
 * boot screen. Replaces the legacy initials-only brand placeholder.
 *
 * Inline SVG (no fetch, no extra request). The gradient id is scoped per
 * instance to avoid collisions when multiple BrandMarks render on the same
 * page.
 */
import React, { useId } from 'react'
import { useT } from '../i18n'

type BrandMarkProps = {
  size?: number
  withWordmark?: boolean
  className?: string
}

export function BrandMark({ size = 32, withWordmark = false, className }: BrandMarkProps) {
  const { t } = useT()
  const gradId = useId().replace(/[:]/g, '')
  const wordmarkSize = Math.round(size * 0.78)
  return (
    <span className={className ? `brand-mark-lockup ${className}` : 'brand-mark-lockup'}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        role={withWordmark ? undefined : 'img'}
        aria-label={withWordmark ? undefined : t('app.brand')}
        aria-hidden={withWordmark ? 'true' : undefined}
        className="brand-mark-svg"
      >
        <defs>
          <linearGradient id={`brand-${gradId}`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="var(--we-primary)" />
            <stop offset="1" stopColor="var(--we-accent)" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="14" fill={`url(#brand-${gradId})`} />
        <path
          d="M20 20 L32 44 L44 20"
          stroke="var(--we-brand-glyph)"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="20" r="5" fill="var(--we-brand-glyph)" />
        <circle cx="44" cy="20" r="5" fill="var(--we-brand-glyph)" />
        <circle cx="32" cy="44" r="5" fill="var(--we-brand-glyph)" />
      </svg>
      {withWordmark && (
        <span className="brand-mark-word" style={{ fontSize: wordmarkSize * 0.42 }}>
          {t('app.brand')}
        </span>
      )}
    </span>
  )
}
