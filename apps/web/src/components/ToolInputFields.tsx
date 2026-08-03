import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../i18n'
import { tToolInputLabel } from '../i18n/tool-input-label'
import type { ToolInputFieldSchema, ToolSchema } from '../types'
import { inputDisplayLabel } from './input-display-label'
import { JsonConfigField, fieldId } from './quick-config-fields'
import {
  applyToolInputDraft,
  formatToolInputDraft,
  isToolInputObject,
  parseToolInputDraft,
  type ParsedToolInputDraft,
  type ToolInputDraftError,
} from './tool-input-model'

const MULTILINE_FIELDS = /^(body|content|html|payload|query|sql|template|text)$/i

function errorKey(error: ToolInputDraftError): string {
  if (error === 'required') return 'runInput.error.required'
  if (error === 'number') return 'runInput.error.notNumber'
  if (error === 'json') return 'runInput.error.notJson'
  return `rightPanel.quickConfig.toolInputError.${error}`
}

function ToolInputField({
  scope,
  field,
  draft,
  onChange,
}: {
  scope: string
  field: ToolInputFieldSchema
  draft: string
  onChange: (
    field: ToolInputFieldSchema,
    parsed: Exclude<ParsedToolInputDraft, { ok: false }>,
  ) => void
}) {
  const { t } = useT()
  const [error, setError] = useState<ToolInputDraftError | null>(null)
  const label = tToolInputLabel(field.name, inputDisplayLabel(field.name))
  const id = fieldId(scope, field.name)
  const datalistId = `${id}-options`
  const errorId = `${id}-error`
  const options = field.kind === 'boolean' ? ['true', 'false'] : field.options

  const commit = (value: string) => {
    const parsed = parseToolInputDraft(field, value)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setError(null)
    onChange(field, parsed)
  }

  const common = {
    id,
    defaultValue: draft,
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => commit(event.currentTarget.value),
    'aria-required': field.required || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
  } as const

  const control = field.kind === 'json' || (field.kind === 'string' && MULTILINE_FIELDS.test(field.name))
    ? <textarea {...common} className="code-field code-field-short" />
    : (
        <>
          <input
            {...common}
            className="text-field"
            inputMode={field.kind === 'number' || field.kind === 'integer' ? 'decimal' : undefined}
            list={options?.length ? datalistId : undefined}
          />
          {options?.length && (
            <datalist id={datalistId}>
              {options.map(option => <option key={option}>{option}</option>)}
            </datalist>
          )}
        </>
      )

  return (
    <div className="config-field-row">
      <label className="field-label run-input-field-label" htmlFor={id}>
        <span>{label}</span>
        <small data-required={field.required ? 'true' : 'false'} aria-hidden="true">
          {t(field.required ? 'runInput.required' : 'runInput.optional')}
        </small>
      </label>
      {control}
      {error && (
        <p className="run-input-field-error" id={errorId} role="alert">
          {t(errorKey(error), { label })}
        </p>
      )}
    </div>
  )
}

export type ToolInputFieldsProps = {
  scope: string
  tool: ToolSchema
  input: unknown
  onChange: (input: unknown) => void
}

export function ToolInputFields({
  scope,
  tool,
  input,
  onChange,
}: ToolInputFieldsProps) {
  const { t } = useT()
  const normalizedInput = input === undefined ? {} : input
  const objectInput = isToolInputObject(normalizedInput) ? normalizedInput : null

  const commit = (
    field: ToolInputFieldSchema,
    parsed: Exclude<ParsedToolInputDraft, { ok: false }>,
  ) => {
    if (!objectInput) return
    onChange(applyToolInputDraft(objectInput, field, parsed))
  }

  return (
    <div className="form-grid">
      {!objectInput && (
        <div className="issue issue-error" role="alert">
          {t('rightPanel.quickConfig.toolInputObjectRequired')}
        </div>
      )}

      {objectInput && tool.inputFields.map((field) => {
        const draft = formatToolInputDraft(objectInput[field.name], field.kind)
        return (
          <ToolInputField
            key={`${field.name}:${draft}`}
            scope={`${scope}-tool-input`}
            field={field}
            draft={draft}
            onChange={commit}
          />
        )
      })}

      <details className="we-config-disclosure">
        <summary>
          <strong>{t('rightPanel.inspector.advancedJsonSummary')}</strong>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div className="we-config-disclosure__body">
          <JsonConfigField
            scope={`${scope}-advanced`}
            label={t('rightPanel.quickConfig.toolInput')}
            value={input}
            onChange={onChange}
          />
        </div>
      </details>
    </div>
  )
}
