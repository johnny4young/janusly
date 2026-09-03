import { useId, type InputHTMLAttributes, type ReactNode } from 'react'

export type SwitchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & {
  hint?: ReactNode
  label: ReactNode
}

/** A labelled native checkbox presented as a switch. Native checked, disabled,
 * focus, and form semantics remain the source of truth. */
export function SwitchField({
  className,
  hint,
  id,
  label,
  ...props
}: SwitchFieldProps) {
  const generatedId = useId()
  const controlId = id ?? `ui-switch-${generatedId}`
  const labelId = `${controlId}-label`
  const hintId = hint ? `${controlId}-hint` : undefined

  return (
    <label className={['ui-switch-field', className].filter(Boolean).join(' ')} htmlFor={controlId}>
      <input
        {...props}
        id={controlId}
        type="checkbox"
        className="ui-switch-field__control"
        aria-labelledby={labelId}
        aria-describedby={hintId}
      />
      <span className="ui-switch-field__track" aria-hidden="true">
        <span className="ui-switch-field__thumb" />
      </span>
      <span className="ui-switch-field__copy">
        <span id={labelId} className="ui-switch-field__label">{label}</span>
        {hint ? <span id={hintId} className="ui-switch-field__hint">{hint}</span> : null}
      </span>
    </label>
  )
}
