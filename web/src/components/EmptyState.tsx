import type { ReactNode } from 'react'
import { Button } from './ui/Button'

export type EmptyStateProps = {
  icon: ReactNode
  kicker: string
  body: string
  cta?: {
    label: string
    onClick: () => void
  }
  /** Optional link beside the primary action, such as related documentation. */
  secondary?: {
    label: string
    href: string
  }
  /** Override the default `empty-state` testid so call sites that already
   *  ship a surface-specific testid (e.g. `dlq-empty`) keep their existing
   *  test contract without per-call-site wrappers. */
  testId?: string
}

export function EmptyState({ icon, kicker, body, cta, secondary, testId }: EmptyStateProps) {
  return (
    <div className="we-empty-state" data-testid={testId ?? 'empty-state'}>
      <div className="we-empty-state__icon" aria-hidden>
        {icon}
      </div>
      <div className="we-empty-state__copy">
        <strong className="we-empty-state__kicker">{kicker}</strong>
        <span className="we-empty-state__body">{body}</span>
      </div>
      {cta ? (
        <Button
          variant="primary"
          className="we-empty-state__cta"
          onClick={cta.onClick}
          data-testid="empty-state-cta"
        >
          {cta.label}
        </Button>
      ) : null}
      {secondary ? (
        <a
          className="we-empty-state__link"
          href={secondary.href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="empty-state-secondary"
        >
          {secondary.label}
        </a>
      ) : null}
    </div>
  )
}
