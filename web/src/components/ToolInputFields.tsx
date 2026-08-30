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
import { FormDisclosure, FormField } from './ui/Form'

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

  return (
    <FormField
      id={id}
      label={label}
      required={field.required}
      error={error ? t(errorKey(error), { label }) : undefined}
    >
      {controlProps => (
        <>
          {field.kind === 'json' || (field.kind === 'string' && MULTILINE_FIELDS.test(field.name)) ? (
            <textarea
              {...controlProps}
              className="ui-config-code ui-config-code--short"
              defaultValue={draft}
              aria-required={field.required || undefined}
              onBlur={(event) => commit(event.currentTarget.value)}
            />
          ) : (
            <input
              {...controlProps}
              defaultValue={draft}
              aria-required={field.required || undefined}
              inputMode={field.kind === 'number' || field.kind === 'integer' ? 'decimal' : undefined}
              list={options?.length ? datalistId : undefined}
              onBlur={(event) => commit(event.currentTarget.value)}
            />
          )}
          {options?.length ? (
            <datalist id={datalistId}>
              {options.map(option => <option key={option}>{option}</option>)}
            </datalist>
          ) : null}
        </>
      )}
    </FormField>
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
    <div className="ui-config-stack">
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

      <FormDisclosure
        summary={(
          <span className="ui-config-disclosure-summary">
            <strong>{t('rightPanel.inspector.advancedJsonSummary')}</strong>
            <ChevronDown size={15} aria-hidden="true" />
          </span>
        )}
      >
          <JsonConfigField
            scope={`${scope}-advanced`}
            label={t('rightPanel.quickConfig.toolInput')}
            value={input}
            onChange={onChange}
          />
      </FormDisclosure>
    </div>
  )
}
