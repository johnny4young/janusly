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
  /** Override the default `empty-state` testid so call sites that already
   *  ship a surface-specific testid (e.g. `dlq-empty`) keep their existing
   *  test contract without per-call-site wrappers. */
  testId?: string
}

export function EmptyState({ icon, kicker, body, cta, testId }: EmptyStateProps) {
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
          variant="ghost"
          size="sm"
          className="we-empty-state__cta"
          onClick={cta.onClick}
          data-testid="empty-state-cta"
        >
          {cta.label}
        </Button>
      ) : null}
    </div>
  )
}
