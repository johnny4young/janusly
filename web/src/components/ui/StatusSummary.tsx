import type { ReactNode } from 'react'

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function StatusSummary({
  actions,
  className,
  description,
  icon,
  role,
  title,
  tone = 'neutral',
}: {
  actions?: ReactNode
  className?: string
  description?: ReactNode
  icon?: ReactNode
  role?: 'alert' | 'status'
  title: ReactNode
  tone?: StatusTone
}) {
  return (
    <div
      className={['ui-status-summary', `ui-status-summary--${tone}`, className].filter(Boolean).join(' ')}
      role={role}
    >
      {icon ? <span className="ui-status-summary__icon" aria-hidden="true">{icon}</span> : null}
      <div className="ui-status-summary__content">
        <strong className="ui-status-summary__title">{title}</strong>
        {description ? <div className="ui-status-summary__description">{description}</div> : null}
      </div>
      {actions ? <div className="ui-status-summary__actions">{actions}</div> : null}
    </div>
  )
}
