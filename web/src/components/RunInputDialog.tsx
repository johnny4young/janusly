/**
 * Schema-driven run-input dialog. Opens when the operator presses Run on a
 * workflow that declared a typed `inputs` shape. Renders a controlled form
 * built from the JSON-Schema-subset (string / number / boolean / object /
 * array + enum + required), validates locally, and hands the parsed input
 * back via `onSubmit`. The engine's input validator stays the source of
 * truth — this form is best-effort UX sugar to spare a round-trip and
 * place server-side errors next to the right field.
 *
 * Server errors come in JSONPath-style strings (e.g.
 * `"$.invoiceId is required"`) — we strip the `$.` prefix and split on
 * `.` to map each error to the field it targets. Errors whose path
 * doesn't match any field render in the top-of-form banner.
 *
 * Visual posture: a lifted-up `we-card` with the workflow name in the
 * header, the same `section-kicker` + `<h2>` grammar the inspector uses,
 * cobalt primary on the Run button, and a soft fade-in. ESC closes.
 *
 * Used by `App.tsx` — wraps `startWorkflow` so the dialog mounts only
 * when `currentWorkflowInputs` is declared. Workflows without inputs keep
 * the one-click run path.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { AlertCircle, Play, Workflow, X } from 'lucide-react'
import type { WorkflowInputSchemaShape } from '../types'
import { useT } from '../i18n'
import {
  getRunInputValue,
  initialRunInputState,
  inputDisplayLabel,
  orderedRunInputEntries,
  parseRunInputState,
  setRunInputValue,
  splitRunInputServerErrors,
  type RunInputErrorMap,
  type RunInputFormState,
} from './run-input-model'

export type RunInputDialogProps = {
  /** Declared `inputs` schema for the current workflow. Required because the dialog is only mounted when inputs exist. */
  inputs: WorkflowInputSchemaShape
  /** Optional schema-valid value used to prefill the form on mount. */
  initialValue?: unknown
  /** Run-friendly workflow name to anchor the header. */
  workflowName?: string
  /** Optional header kicker for reuse by other schema-driven operator forms. */
  kicker?: string
  /** Optional title override. Defaults to `workflowName` or "Start workflow". */
  title?: string
  /** Optional description override. */
  description?: string
  /** Submit button copy. */
  submitLabel?: string
  /** Submit button copy while `submitting` is true. */
  submittingLabel?: string
  /** Accessible label for the close button. */
  closeLabel?: string
  /** JSONPath-style errors echoed from `POST /start` (e.g. `"$.invoiceId is required"`). */
  serverErrors?: string[]
  /** Disables the submit button while the run-start request is in flight. */
  submitting?: boolean
  /** Resolves with the parsed input value (string / number / boolean / object / array). */
  onSubmit: (input: unknown) => void | Promise<void>
  /** Cancel via the close button, the backdrop, or ESC. */
  onCancel: () => void
  /**
   * Named input presets for this workflow. Optional: run flows pass them;
   * other schema-driven forms (human forms) leave the seam unset and the
   * dialog renders exactly as before.
   */
  presets?: RunInputPreset[]
  /** Persist the CURRENT form value under a name; resolves the fresh list. */
  onSavePreset?: (name: string, input: unknown) => void | Promise<void>
}

export type RunInputPreset = {
  name: string
  input: unknown
}

export function RunInputDialog({
  inputs,
  initialValue,
  workflowName,
  kicker,
  title,
  description,
  submitLabel,
  submittingLabel,
  closeLabel,
  serverErrors,
  submitting = false,
  onSubmit,
  onCancel,
  presets,
  onSavePreset,
}: RunInputDialogProps) {
  const { t } = useT()
  const resolvedKicker = kicker ?? (t('runInput.kicker'))
  const resolvedDescription = description ?? (t('runInput.description'))
  const resolvedSubmitLabel = submitLabel ?? (t('runInput.submit'))
  const resolvedSubmittingLabel = submittingLabel ?? (t('runInput.starting'))
  const resolvedCloseLabel = closeLabel ?? (t('runInput.close'))
  const isObjectRoot = inputs.type === 'object' && inputs.properties
  const [state, setState] = useState<RunInputFormState>(() => initialRunInputState(inputs, initialValue))
  const [localErrors, setLocalErrors] = useState<RunInputErrorMap>({})
  const [presetName, setPresetName] = useState('')
  const [presetBusy, setPresetBusy] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocusTrap(dialogRef, { initialFocus: firstFieldRef })

  // Server errors are remapped per render (no caching) so re-fetching a
  // fresh `serverErrors` prop replaces the inline error text without a
  // dance through useEffect.
  const { mappedServerErrors, formLevelServerErrors } = useMemo(
    () => splitRunInputServerErrors(serverErrors ?? [], inputs),
    [serverErrors, inputs],
  )

  // ESC closes — common modal expectation. Suppress while a submit is in
  // flight so the operator can't unmount the dialog before the POST
  // resolves: the parent's error-handling path (e.g. RightPanel surfacing
  // human_form field errors) needs the dialog mounted to receive the
  // response.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, submitting])

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      const { value, errors } = parseRunInputState(state, inputs)
      if (Object.keys(errors).length > 0) {
        setLocalErrors(errors)
        return
      }
      setLocalErrors({})
      await onSubmit(value)
    },
    [inputs, onSubmit, state],
  )

  // Clear the local error for a field as soon as its value changes — keeps
  // stale errors from a prior failed submit from lingering after the
  // operator typed the missing value. Server errors come in via prop and
  // re-render naturally when the parent passes a fresh `serverErrors`.
  const clearLocalError = useCallback((path: string) => {
    setLocalErrors((prev) => {
      if (!(path in prev)) return prev
      const { [path]: _removed, ...rest } = prev
      return rest
    })
  }, [])

  const errors: RunInputErrorMap = { ...mappedServerErrors, ...localErrors }

  // Cancel paths (backdrop click, close button, ESC) must no-op while a
  // submit is in flight. Without this guard the parent can unmount the
  // dialog before the POST resolves, dropping the server's field-error
  // response on the floor and leaving the run paused.
  const handleCancel = useCallback(() => {
    if (submitting) return
    onCancel()
  }, [submitting, onCancel])

  return (
    <div className="run-input-backdrop" onClick={handleCancel}>
      <div
        ref={dialogRef}
        className="run-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-input-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="run-input-dialog__header">
          <span className="run-input-dialog__icon" aria-hidden="true">
            <Workflow size={18} />
          </span>
          <div className="run-input-dialog__heading">
            <div className="section-kicker">{resolvedKicker}</div>
            <h2 id="run-input-title">{title?.trim() || workflowName?.trim() || (t('runInput.title'))}</h2>
            <p className="helper-text">{resolvedDescription}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={handleCancel}
            aria-label={resolvedCloseLabel}
            disabled={submitting}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <form className="run-input-dialog__body" onSubmit={handleSubmit}>
          {presets !== undefined && (
            <div className="run-input-presets" data-testid="run-input-presets">
              {presets.length > 0 && (
                <label className="run-input-presets__load">
                  <span className="helper-text">{t('runInput.presets.load')}</span>
                  <select
                    data-testid="run-input-preset-select"
                    value=""
                    disabled={submitting || presetBusy}
                    onChange={(event) => {
                      const chosen = presets.find((preset) => preset.name === event.target.value)
                      if (chosen) setState(initialRunInputState(inputs, chosen.input))
                    }}
                  >
                    <option value="">{t('runInput.presets.placeholder')}</option>
                    {presets.map((preset) => (
                      <option key={preset.name} value={preset.name}>{preset.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {onSavePreset && (
                <div className="run-input-presets__save">
                  <input
                    type="text"
                    data-testid="run-input-preset-name"
                    placeholder={t('runInput.presets.namePlaceholder')}
                    maxLength={60}
                    value={presetName}
                    disabled={submitting || presetBusy}
                    onChange={(event) => setPresetName(event.target.value)}
                  />
                  <button
                    type="button"
                    className="small-command"
                    data-testid="run-input-preset-save"
                    disabled={submitting || presetBusy || presetName.trim() === ''}
                    onClick={() => {
                      // Presets persist only a VALID value: reusing the same
                      // parser as submit keeps saved shapes runnable.
                      const { value, errors } = parseRunInputState(state, inputs)
                      if (Object.keys(errors).length > 0) {
                        setLocalErrors(errors)
                        return
                      }
                      setPresetBusy(true)
                      void Promise.resolve(onSavePreset(presetName.trim(), value))
                        .then(() => setPresetName(''))
                        .finally(() => setPresetBusy(false))
                    }}
                  >
                    {t('runInput.presets.save')}
                  </button>
                </div>
              )}
            </div>
          )}
          {formLevelServerErrors.length > 0 && (
            <div className="run-input-form-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <div>
                {formLevelServerErrors.map((message, index) => (
                  <div key={`${message}-${index}`}>{message}</div>
                ))}
              </div>
            </div>
          )}

          {isObjectRoot ? (
            <ObjectFields
              schema={inputs}
              path=""
              state={state}
              setState={setState}
              errors={errors}
              clearLocalError={clearLocalError}
              firstFieldRef={firstFieldRef}
            />
          ) : (
            <PrimitiveOrArrayField
              schema={inputs}
              path=""
              required={inputs.default === undefined}
              state={state}
              setState={setState}
              errors={errors}
              clearLocalError={clearLocalError}
              firstFieldRef={firstFieldRef}
            />
          )}

          <footer className="run-input-dialog__footer">
            <button type="button" className="command-button" onClick={handleCancel} disabled={submitting}>
              {t('runInput.cancel')}
            </button>
            <button
              type="submit"
              className="command-button command-button-primary"
              disabled={submitting}
            >
              <Play size={14} aria-hidden="true" />
              <span>{submitting ? resolvedSubmittingLabel : resolvedSubmitLabel}</span>
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

/* ----------------------------- Field renderers ---------------------------- */

type FieldProps = {
  schema: WorkflowInputSchemaShape
  path: string
  state: RunInputFormState
  setState: React.Dispatch<React.SetStateAction<RunInputFormState>>
  errors: RunInputErrorMap
  /** Drop the local error for `path` from the dialog's error map — invoked when the field value changes. */
  clearLocalError: (path: string) => void
  firstFieldRef?: React.MutableRefObject<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>
  required?: boolean
  label?: string
}

function ObjectFields({ schema, path, state, setState, errors, clearLocalError, firstFieldRef }: FieldProps) {
  if (schema.type !== 'object' || !schema.properties) return null
  const requiredSet = new Set(schema.required ?? [])
  const entries = orderedRunInputEntries(schema)

  return (
    <div className="run-input-grid">
      {entries.map(([key, child], index) => {
        const childPath = path ? `${path}.${key}` : key
        const isFirst = index === 0
        return (
          <FieldRouter
            key={childPath}
            schema={child}
            path={childPath}
            state={state}
            setState={setState}
            errors={errors}
            clearLocalError={clearLocalError}
            required={requiredSet.has(key)}
            label={inputDisplayLabel(key)}
            firstFieldRef={isFirst ? firstFieldRef : undefined}
          />
        )
      })}
    </div>
  )
}

function FieldRouter(props: FieldProps) {
  const { schema } = props
  const { t } = useT()
  if (schema.type === 'object' && schema.properties) {
    return (
      <fieldset className="run-input-fieldset">
        <legend className="field-label run-input-field-label">
          <span>{props.label ?? inputDisplayLabel(props.path)}</span>
          <small data-required={props.required ? 'true' : 'false'} aria-hidden="true">
            {props.required ? t('runInput.required') : t('runInput.optional')}
          </small>
        </legend>
        {schema.description && <p className="helper-text">{schema.description}</p>}
        <ObjectFields
          schema={schema}
          path={props.path}
          state={props.state}
          setState={props.setState}
          errors={props.errors}
          clearLocalError={props.clearLocalError}
          firstFieldRef={props.firstFieldRef}
        />
      </fieldset>
    )
  }
  return <PrimitiveOrArrayField {...props} />
}

function PrimitiveOrArrayField({
  schema,
  path,
  state,
  setState,
  errors,
  clearLocalError,
  firstFieldRef,
  required,
  label,
}: FieldProps) {
  const { t } = useT()
  const inputId = `run-input-${path || 'root'}`
  const errorId = `${inputId}-error`
  const error = errors[path]
  const displayLabel = label ?? inputDisplayLabel(path)
  const value = getRunInputValue(state, path)
  const setValue = (next: unknown) => {
    setState((prev) => setRunInputValue(prev, path, next))
    // Drop the field's stale local error so a value typed after a failed
    // submit clears the inline message immediately rather than waiting
    // for the next submit attempt.
    clearLocalError(path)
  }

  const labelNode = (
    <label className="field-label run-input-field-label" htmlFor={inputId}>
      <span>{displayLabel}</span>
      <small data-required={required ? 'true' : 'false'} aria-hidden="true">
        {required ? t('runInput.required') : t('runInput.optional')}
      </small>
    </label>
  )

  let control: React.ReactNode

  if (schema.type === 'string' && Array.isArray(schema.enum) && schema.enum.length > 0) {
    control = (
      <select
        id={inputId}
        className="text-field"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => setValue(event.target.value)}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        ref={firstFieldRef as React.MutableRefObject<HTMLSelectElement | null> | undefined}
      >
        <option value="">{t('runInput.select')}</option>
        {schema.enum.map((option) => {
          const text = typeof option === 'string' ? option : JSON.stringify(option)
          return (
            <option key={text} value={text}>
              {text}
            </option>
          )
        })}
      </select>
    )
  } else if (schema.type === 'string') {
    control = (
      <input
        id={inputId}
        className="text-field"
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => setValue(event.target.value)}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        ref={firstFieldRef as React.MutableRefObject<HTMLInputElement | null> | undefined}
      />
    )
  } else if (schema.type === 'number') {
    control = (
      <input
        id={inputId}
        className="text-field"
        type="number"
        value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
        onChange={(event) => setValue(event.target.value)}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        ref={firstFieldRef as React.MutableRefObject<HTMLInputElement | null> | undefined}
      />
    )
  } else if (schema.type === 'boolean') {
    control = (
      <select
        id={inputId}
        className="text-field"
        value={value === true ? 'true' : value === false ? 'false' : ''}
        onChange={(event) => {
          const selected = event.target.value
          setValue(selected === '' ? undefined : selected === 'true')
        }}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        ref={firstFieldRef as React.MutableRefObject<HTMLSelectElement | null> | undefined}
      >
        <option value="">{t('runInput.select')}</option>
        <option value="true">{t('runInput.booleanTrue')}</option>
        <option value="false">{t('runInput.booleanFalse')}</option>
      </select>
    )
  } else if (schema.type === 'array') {
    control = (
      <textarea
        id={inputId}
        className="code-field code-field-short"
        value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)}
        onChange={(event) => setValue(event.target.value)}
        placeholder='["a", "b", "c"]'
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        ref={firstFieldRef as React.MutableRefObject<HTMLTextAreaElement | null> | undefined}
      />
    )
  } else {
    // Object without properties or unknown — fall back to JSON textarea so
    // the field is still usable instead of vanishing silently.
    control = (
      <textarea
        id={inputId}
        className="code-field code-field-short"
        value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)}
        onChange={(event) => setValue(event.target.value)}
        placeholder='{ "key": "value" }'
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        ref={firstFieldRef as React.MutableRefObject<HTMLTextAreaElement | null> | undefined}
      />
    )
  }

  return (
    <div className="config-field-row">
      {labelNode}
      {schema.description && <p className="helper-text">{schema.description}</p>}
      {control}
      {error && (
        <p className="run-input-field-error" id={errorId} role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}
