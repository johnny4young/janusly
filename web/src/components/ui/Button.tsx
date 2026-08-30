import { LoaderCircle } from 'lucide-react'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean
  loadingLabel?: string
  size?: ButtonSize
  variant?: ButtonVariant
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

/** Canonical Janusly action primitive. It preserves native button semantics
 * while making loading, focus, sizing, and visual hierarchy consistent. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    disabled,
    leadingIcon,
    loading = false,
    loadingLabel,
    size = 'md',
    trailingIcon,
    type = 'button',
    variant = 'secondary',
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={[
        'ui-button',
        `ui-button--${variant}`,
        `ui-button--${size}`,
        loading && 'ui-button--loading',
        className,
      ].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <LoaderCircle className="ui-button__spinner" size={16} aria-hidden="true" />
      ) : leadingIcon ? (
        <span className="ui-button__icon" aria-hidden="true">{leadingIcon}</span>
      ) : null}
      <span className="ui-button__label">{loading && loadingLabel ? loadingLabel : children}</span>
      {!loading && trailingIcon ? (
        <span className="ui-button__icon" aria-hidden="true">{trailingIcon}</span>
      ) : null}
    </button>
  )
})
