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
 * Visual posture: a lifted-up `panel-card` with the workflow name in the
 * header, the same `section-kicker` + `<h2>` grammar the inspector uses,
 * cobalt primary on the Run button, and a soft fade-in. ESC closes.
 *
 * Used by `App.tsx` — wraps `startWorkflow` so the dialog mounts only
 * when `currentWorkflowInputs` is declared. Workflows without inputs keep
 * the one-click run path.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Play, Workflow, X } from 'lucide-react'
import type { WorkflowInputSchemaShape } from '../types'

type RunInputDialogProps = {
  /** Declared `inputs` schema for the current workflow. Required because the dialog is only mounted when inputs exist. */
  inputs: WorkflowInputSchemaShape
  /** Run-friendly workflow name to anchor the header. */
  workflowName?: string
  /** JSONPath-style errors echoed from `POST /start` (e.g. `"$.invoiceId is required"`). */
  serverErrors?: string[]
  /** Disables the submit button while the run-start request is in flight. */
  submitting?: boolean
  /** Resolves with the parsed input value (string / number / boolean / object / array). */
  onSubmit: (input: unknown) => void | Promise<void>
  /** Cancel via the close button, the backdrop, or ESC. */
  onCancel: () => void
}

/** Local form state — leaf values stored as strings so empty `""` is meaningful, JSON parsed at submit. */
type FormState = Record<string, unknown>

/** Field-path → user-visible error string. Computed per render from local + server errors. */
type ErrorMap = Record<string, string>

const DESCRIPTION =
  'Provide the values this workflow needs to start. Validated locally; the engine re-validates on submit.'

export function RunInputDialog({
  inputs,
  workflowName,
  serverErrors,
  submitting = false,
  onSubmit,
  onCancel,
}: RunInputDialogProps) {
  const isObjectRoot = inputs.type === 'object' && inputs.properties
  const [state, setState] = useState<FormState>(() => initialFormState(inputs))
  const [localErrors, setLocalErrors] = useState<ErrorMap>({})
  const firstFieldRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null)

  // Server errors are remapped per render (no caching) so re-fetching a
  // fresh `serverErrors` prop replaces the inline error text without a
  // dance through useEffect.
  const { mappedServerErrors, formLevelServerErrors } = useMemo(
    () => splitServerErrors(serverErrors ?? [], inputs),
    [serverErrors, inputs],
  )

  // Focus the first field on mount so the user can start typing immediately.
  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  // ESC closes — common modal expectation.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      const { value, errors } = parseFormState(state, inputs)
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

  const errors: ErrorMap = { ...mappedServerErrors, ...localErrors }

  return (
    <div className="run-input-backdrop" onClick={onCancel}>
      <div
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
            <div className="section-kicker">Run input</div>
            <h2 id="run-input-title">{workflowName?.trim() ? workflowName : 'Start workflow'}</h2>
            <p className="helper-text">{DESCRIPTION}</p>
          </div>
          <button
            type="button"
            className="run-input-dialog__close"
            onClick={onCancel}
            aria-label="Close run input"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <form className="run-input-dialog__body" onSubmit={handleSubmit}>
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
              state={state}
              setState={setState}
              errors={errors}
              clearLocalError={clearLocalError}
              firstFieldRef={firstFieldRef}
            />
          )}

          <footer className="run-input-dialog__footer">
            <button type="button" className="command-button" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="command-button command-button-primary"
              disabled={submitting}
            >
              <Play size={14} aria-hidden="true" />
              <span>{submitting ? 'Starting…' : 'Run workflow'}</span>
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
  state: FormState
  setState: React.Dispatch<React.SetStateAction<FormState>>
  errors: ErrorMap
  /** Drop the local error for `path` from the dialog's error map — invoked when the field value changes. */
  clearLocalError: (path: string) => void
  firstFieldRef?: React.MutableRefObject<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>
  required?: boolean
  label?: string
}

function ObjectFields({ schema, path, state, setState, errors, clearLocalError, firstFieldRef }: FieldProps) {
  if (schema.type !== 'object' || !schema.properties) return null
  const requiredSet = new Set(schema.required ?? [])
  const entries = Object.entries(schema.properties)

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
            label={key}
            firstFieldRef={isFirst ? firstFieldRef : undefined}
          />
        )
      })}
    </div>
  )
}

function FieldRouter(props: FieldProps) {
  const { schema } = props
  if (schema.type === 'object' && schema.properties) {
    return (
      <fieldset className="run-input-fieldset">
        <legend className="field-label">
          {props.label ?? props.path}
          {props.required && <span aria-hidden="true" className="run-input-required">*</span>}
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
  const inputId = `run-input-${path || 'root'}`
  const errorId = `${inputId}-error`
  const error = errors[path]
  const displayLabel = label ?? (path || 'Input')
  const value = getAtPath(state, path)
  const setValue = (next: unknown) => {
    setState((prev) => setAtPath(prev, path, next))
    // Drop the field's stale local error so a value typed after a failed
    // submit clears the inline message immediately rather than waiting
    // for the next submit attempt.
    clearLocalError(path)
  }

  const labelNode = (
    <label className="field-label" htmlFor={inputId}>
      {displayLabel}
      {required && <span aria-hidden="true" className="run-input-required">*</span>}
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
        <option value="">— Select —</option>
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
      <label className="run-input-checkbox">
        <input
          id={inputId}
          type="checkbox"
          checked={value === true}
          onChange={(event) => setValue(event.target.checked)}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          ref={firstFieldRef as React.MutableRefObject<HTMLInputElement | null> | undefined}
        />
        <span>Enabled</span>
      </label>
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

/* ----------------------------- Form state I/O ----------------------------- */

function initialFormState(schema: WorkflowInputSchemaShape): FormState {
  if (schema.type === 'object' && schema.properties) {
    const obj: FormState = {}
    for (const [key, child] of Object.entries(schema.properties)) {
      obj[key] = initialLeafValue(child)
    }
    return obj
  }
  return { __root__: initialLeafValue(schema) }
}

function initialLeafValue(schema: WorkflowInputSchemaShape): unknown {
  if (schema.type === 'boolean') return false
  if (schema.type === 'object' && schema.properties) {
    const nested: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(schema.properties)) {
      nested[key] = initialLeafValue(child)
    }
    return nested
  }
  return ''
}

function getAtPath(state: FormState, path: string): unknown {
  if (!path) return state.__root__
  const segments = path.split('.')
  let cursor: unknown = state
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function setAtPath(state: FormState, path: string, value: unknown): FormState {
  if (!path) return { ...state, __root__: value }
  const segments = path.split('.')
  const next: FormState = { ...state }
  let cursor: Record<string, unknown> = next
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    const existing = cursor[segment]
    cursor[segment] = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]] = value
  return next
}

function parseFormState(
  state: FormState,
  schema: WorkflowInputSchemaShape,
): { value: unknown; errors: ErrorMap } {
  if (schema.type === 'object' && schema.properties) {
    const errors: ErrorMap = {}
    const value = parseObject(schema, state, '', errors)
    return { value, errors }
  }
  const errors: ErrorMap = {}
  const value = parseLeaf(schema, state.__root__, '', errors, false)
  return { value, errors }
}

function parseObject(
  schema: WorkflowInputSchemaShape,
  raw: unknown,
  path: string,
  errors: ErrorMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (schema.type !== 'object' || !schema.properties) return out
  const requiredSet = new Set(schema.required ?? [])
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {}
  for (const [key, child] of Object.entries(schema.properties)) {
    const childPath = path ? `${path}.${key}` : key
    const isRequired = requiredSet.has(key)
    if (child.type === 'object' && child.properties) {
      const nested = parseObject(child, obj[key], childPath, errors)
      // A required nested object whose shape declares its own required
      // keys is already caught by the recursion below — but a required
      // nested object that we end up with as `{}` (because the parent
      // never populated it and the child has no required keys of its
      // own) still satisfies the parent's "required" intent only when
      // the operator typed at least one value. Guard the empty-object
      // case explicitly so `required: ['user']` actually means it.
      if (isRequired && Object.keys(nested).filter((k) => nested[k] !== undefined).length === 0) {
        errors[childPath] = `${prettyLabel(childPath)} is required`
      }
      out[key] = nested
      continue
    }
    out[key] = parseLeaf(child, obj[key], childPath, errors, isRequired)
  }
  return out
}

/**
 * Coerce one primitive/array leaf from form state. `required` decides
 * whether an empty value yields an error or just falls through as
 * undefined (engine still validates regardless).
 */
function parseLeaf(
  schema: WorkflowInputSchemaShape,
  raw: unknown,
  path: string,
  errors: ErrorMap,
  required: boolean,
): unknown {
  if (schema.type === 'string') {
    const text = typeof raw === 'string' ? raw : ''
    if (!text) {
      if (required) errors[path] = `${prettyLabel(path)} is required`
      return undefined
    }
    return text
  }
  if (schema.type === 'number') {
    if (raw === '' || raw === undefined || raw === null) {
      if (required) errors[path] = `${prettyLabel(path)} is required`
      return undefined
    }
    const num = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(num)) {
      errors[path] = `${prettyLabel(path)} must be a number`
      return undefined
    }
    return num
  }
  if (schema.type === 'boolean') {
    return raw === true
  }
  if (schema.type === 'array') {
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (!trimmed) {
        if (required) errors[path] = `${prettyLabel(path)} is required`
        return undefined
      }
      try {
        const parsed = JSON.parse(trimmed)
        if (!Array.isArray(parsed)) {
          errors[path] = `${prettyLabel(path)} must be a JSON array`
          return undefined
        }
        return parsed
      } catch {
        errors[path] = `${prettyLabel(path)} must be valid JSON`
        return undefined
      }
    }
    if (Array.isArray(raw)) return raw
    if (required) errors[path] = `${prettyLabel(path)} is required`
    return undefined
  }
  // Unknown / fallback object literal
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) {
      if (required) errors[path] = `${prettyLabel(path)} is required`
      return undefined
    }
    try {
      return JSON.parse(trimmed)
    } catch {
      errors[path] = `${prettyLabel(path)} must be valid JSON`
      return undefined
    }
  }
  return raw
}

/* ----------------------------- Server errors ----------------------------- */

function splitServerErrors(
  raw: string[],
  schema: WorkflowInputSchemaShape,
): { mappedServerErrors: ErrorMap; formLevelServerErrors: string[] } {
  const mapped: ErrorMap = {}
  const formLevel: string[] = []
  const knownPaths = collectFieldPaths(schema, '')

  for (const message of raw) {
    if (!message.startsWith('$.') && message !== '$') {
      formLevel.push(message)
      continue
    }
    const stripped = message.replace(/^\$\.?/, '')
    // The error message format is `<path> <reason>`. The path portion is
    // the leading whitespace-less prefix; everything after the first space
    // is the human-readable reason.
    const firstSpace = stripped.indexOf(' ')
    const pathSegment = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace)
    const reason = firstSpace === -1 ? stripped : stripped.slice(firstSpace + 1)
    const fieldPath = matchKnownPath(pathSegment, knownPaths) ?? pathSegment
    if (!fieldPath) {
      // Bare `$` / `$.` root errors come through with empty pathSegment
      // and reason — surface the original message verbatim so the banner
      // never renders a blank line.
      const fallback = reason || stripped || message
      if (fallback) formLevel.push(fallback)
      continue
    }
    const display = reason ? `${prettyLabel(fieldPath)} ${reason}` : stripped
    mapped[fieldPath] = display
  }

  return { mappedServerErrors: mapped, formLevelServerErrors: formLevel }
}

function collectFieldPaths(schema: WorkflowInputSchemaShape, prefix: string): string[] {
  if (schema.type === 'object' && schema.properties) {
    return Object.entries(schema.properties).flatMap(([key, child]) => {
      const childPath = prefix ? `${prefix}.${key}` : key
      if (child.type === 'object' && child.properties) {
        return [childPath, ...collectFieldPaths(child, childPath)]
      }
      return [childPath]
    })
  }
  return ['']
}

function matchKnownPath(segment: string, knownPaths: string[]): string | undefined {
  if (knownPaths.includes(segment)) return segment
  // Longest-prefix match — handles the `$.user.email` → `user.email` case
  // when a field's name has a dot in it (rare, but cheap to support).
  let best: string | undefined
  for (const candidate of knownPaths) {
    if (segment === candidate || segment.startsWith(`${candidate}.`) || segment.startsWith(`${candidate}[`)) {
      if (!best || candidate.length > best.length) best = candidate
    }
  }
  return best
}

function prettyLabel(path: string): string {
  if (!path) return 'Input'
  return path
}
