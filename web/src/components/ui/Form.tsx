import { useId, type AriaAttributes, type ReactNode } from 'react'

export type FormControlProps = {
  id: string
  className?: string
  'data-ui-control': true
  'aria-describedby'?: string
  'aria-errormessage'?: string
  'aria-invalid'?: AriaAttributes['aria-invalid']
}

export function FormField({
  children,
  className,
  controlClassName,
  error,
  hint,
  id,
  label,
  required = false,
}: {
  children: (controlProps: FormControlProps) => ReactNode
  className?: string
  controlClassName?: string
  error?: ReactNode
  hint?: ReactNode
  id?: string
  label: ReactNode
  required?: boolean
}) {
  const generatedId = useId()
  const controlId = id ?? `ui-field-${generatedId}`
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={['ui-field', className].filter(Boolean).join(' ')}>
      <label className="ui-field__label" htmlFor={controlId}>
        <span>{label}</span>
        {required ? <span className="ui-field__required" aria-hidden="true" /> : null}
      </label>
      {children({
        id: controlId,
        className: controlClassName,
        'data-ui-control': true,
        'aria-describedby': describedBy,
        'aria-errormessage': errorId,
        'aria-invalid': Boolean(error),
      })}
      {hint ? <div id={hintId} className="ui-field__hint">{hint}</div> : null}
      {error ? <div id={errorId} className="ui-field__error" role="alert">{error}</div> : null}
    </div>
  )
}

export function FormSection({
  children,
  className,
  description,
  disabled,
  title,
}: {
  children: ReactNode
  className?: string
  description?: ReactNode
  disabled?: boolean
  title: ReactNode
}) {
  return (
    <fieldset className={['ui-form-section', className].filter(Boolean).join(' ')} disabled={disabled}>
      <legend className="ui-form-section__legend">
        <span className="ui-form-section__title">{title}</span>
        {description ? <span className="ui-form-section__description">{description}</span> : null}
      </legend>
      <div className="ui-form-section__body">{children}</div>
    </fieldset>
  )
}

export function FormActions({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={['ui-form-actions', className].filter(Boolean).join(' ')}>{children}</div>
}

export function FieldStack({
  children,
  className,
  disabled,
  labelledBy,
}: {
  children: ReactNode
  className?: string
  disabled?: boolean
  labelledBy?: string
}) {
  return (
    <fieldset
      className={['ui-field-stack', className].filter(Boolean).join(' ')}
      disabled={disabled}
      aria-labelledby={labelledBy}
    >
      {children}
    </fieldset>
  )
}

export function FormGrid({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={['ui-form-grid', className].filter(Boolean).join(' ')}>{children}</div>
}

export function FormDisclosure({
  children,
  className,
  summary,
}: {
  children: ReactNode
  className?: string
  summary: ReactNode
}) {
  return (
    <details className={['ui-form-disclosure', className].filter(Boolean).join(' ')}>
      <summary className="ui-form-disclosure__summary">{summary}</summary>
      <div className="ui-form-disclosure__body">{children}</div>
    </details>
  )
}
