/**
 * Direct editor for a workflow's top-level input contract and output templates.
 * Nested field schemas are preserved until the operator explicitly changes that
 * field's type; non-object root schemas stay read-only to avoid destructive
 * flattening.
 *
 * Used by: `InspectorPanel.tsx` when no node or edge is selected.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { WorkflowDefinition, WorkflowInputSchemaShape } from '../types'
import { useT } from '../i18n'
import { SelectControl, TextInput } from '@/components/ui/Form'

type SchemaFieldsEditorProps = {
  scope: string
  schema?: unknown
  form?: boolean
  onChange: (schema: WorkflowInputSchemaShape | undefined) => void
}

const INPUT_TYPES: WorkflowInputSchemaShape['type'][] = ['string', 'number', 'boolean', 'object', 'array']

function nextName(base: string, names: Iterable<string>): string {
  const existing = new Set(names)
  if (!existing.has(base)) return base
  let suffix = 2
  while (existing.has(`${base}${suffix}`)) suffix += 1
  return `${base}${suffix}`
}

function shapeForType(type: WorkflowInputSchemaShape['type'], description?: string): WorkflowInputSchemaShape {
  const base = { type, ...(description ? { description } : {}) }
  if (type === 'object') return { ...base, properties: {} }
  if (type === 'array') return { ...base, items: { type: 'string' } }
  return base
}

export function SchemaFieldsEditor({
  scope,
  schema,
  form = false,
  onChange,
}: SchemaFieldsEditorProps) {
  const { t } = useT()
  const parsedSchema = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema as WorkflowInputSchemaShape
    : undefined
  const fields = parsedSchema?.type === 'object' && parsedSchema.properties
    ? Object.values(parsedSchema.properties)
    : []
  const editable = schema === undefined || (
    parsedSchema?.type === 'object'
    && (!form || fields.every(shape => {
      const index = INPUT_TYPES.indexOf(shape?.type)
      return index >= 0 && index < 3
    }))
  )
  const properties = editable && parsedSchema?.type === 'object' ? parsedSchema.properties ?? {} : {}
  const required = new Set(editable && parsedSchema?.type === 'object' ? parsedSchema.required ?? [] : [])
  const writeSchema = (nextProperties: Record<string, WorkflowInputSchemaShape>, nextRequired: Set<string>) => {
    if (Object.keys(nextProperties).length === 0 && !form) {
      onChange(undefined)
      return
    }
    onChange({
      ...(parsedSchema?.type === 'object' ? parsedSchema : {}),
      type: 'object',
      properties: nextProperties,
      ...(nextRequired.size > 0
        ? { required: [...nextRequired].filter(name => Object.hasOwn(nextProperties, name)) }
        : { required: undefined }),
    })
  }
  const addField = () => {
    const name = nextName('input', Object.keys(properties))
    writeSchema({ ...properties, [name]: { type: 'string' } }, required)
  }
  const renameField = (from: string, rawTo: string): boolean => {
    const to = rawTo.trim()
    if (!to || (to !== from && Object.hasOwn(properties, to))) return false
    if (to === from) return true
    const nextProperties = Object.fromEntries(
      Object.entries(properties).map(([name, shape]) => [name === from ? to : name, shape]),
    )
    const nextRequired = new Set([...required].map(name => name === from ? to : name))
    writeSchema(nextProperties, nextRequired)
    return true
  }
  const updateField = (name: string, shape: WorkflowInputSchemaShape) => {
    writeSchema({ ...properties, [name]: shape }, required)
  }
  const removeField = (name: string) => {
    const nextProperties = { ...properties }
    delete nextProperties[name]
    const nextRequired = new Set(required)
    nextRequired.delete(name)
    writeSchema(nextProperties, nextRequired)
  }
  const toggleRequired = (name: string, checked: boolean) => {
    const nextRequired = new Set(required)
    if (checked) nextRequired.add(name)
    else nextRequired.delete(name)
    writeSchema(properties, nextRequired)
  }

  return (
    <div className="we-workflow-io__section" data-testid="workflow-inputs-editor">
      <div className="we-workflow-io__heading">
        <div>
          <strong>{t(form ? 'rightPanel.quickConfig.fieldsSchema' : 'rightPanel.inspector.inputsLabel')}</strong>
          <p>{t(form ? 'rightPanel.quickConfig.humanFormHelper' : 'rightPanel.inspector.inputsHelper')}</p>
        </div>
        {editable && (
          <button type="button" className="small-command" onClick={addField} data-testid="workflow-input-add">
            <Plus size={13} aria-hidden="true" />
            {t('rightPanel.inspector.addInput')}
          </button>
        )}
      </div>
      {!editable ? (
        <div className="issue issue-warning" role="status">
          {t('rightPanel.inspector.inputRootUnsupported', { type: parsedSchema?.type ?? 'unknown' })}
        </div>
      ) : Object.keys(properties).length === 0 ? (
        <p className="we-workflow-io__empty">
          {t('rightPanel.inspector.noInputs')}
        </p>
      ) : (
        <div className="we-workflow-io__rows">
          {Object.entries(properties).map(([name, shape]) => (
            <InputRow
              key={`${scope}:${name}`}
              name={name}
              shape={shape}
              form={form}
              required={required.has(name)}
              onRename={(next) => renameField(name, next)}
              onTypeChange={(type) => updateField(name, shapeForType(type, shape.description))}
              onDescriptionChange={(description) => updateField(name, { ...shape, description: description || undefined })}
              onDefaultChange={(value) => {
                const { default: _cleared, ...rest } = shape
                updateField(name, value === undefined ? rest : { ...rest, default: value })
              }}
              onRequiredChange={(checked) => toggleRequired(name, checked)}
              onRemove={() => removeField(name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default SchemaFieldsEditor

/** Shared name-editing state for input and output rows: the draft, the
 *  rejected-rename flag, and the commit that trims an accepted name. */
function useNameDraft(name: string, onRename: (name: string) => boolean) {
  const nameErrorId = useId()
  const [nameDraft, setNameDraft] = useState(name)
  const [nameError, setNameError] = useState(false)
  const commitName = () => {
    const accepted = onRename(nameDraft)
    setNameError(!accepted)
    if (accepted) setNameDraft(nameDraft.trim())
  }
  return { nameErrorId, nameDraft, setNameDraft, nameError, setNameError, commitName }
}

function InputRow({ name, shape, form, required, onRename, onTypeChange, onDescriptionChange, onDefaultChange, onRequiredChange, onRemove }: {
  name: string
  shape: WorkflowInputSchemaShape
  form: boolean
  required: boolean
  onRename: (name: string) => boolean
  onTypeChange: (type: WorkflowInputSchemaShape['type']) => void
  onDescriptionChange: (description: string) => void
  /** `undefined` clears the declared default rather than storing an empty value. */
  onDefaultChange: (value: unknown) => void
  onRequiredChange: (required: boolean) => void
  onRemove: () => void
}) {
  const { t } = useT()
  const { nameErrorId, nameDraft, setNameDraft, nameError, setNameError, commitName } = useNameDraft(name, onRename)
  return (
    <div className="we-workflow-io__row" data-testid={`workflow-input-${name}`}>
      <div className="we-workflow-io__row-main">
        <label>
          <span className="we-sr-only">{t('rightPanel.inspector.inputNameAria', { name })}</span>
          <TextInput
            value={nameDraft}
            maxLength={80}
            aria-invalid={nameError || undefined}
            aria-describedby={nameError ? nameErrorId : undefined}
            onChange={(event) => { setNameDraft(event.target.value); setNameError(false) }}
            onBlur={commitName}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </label>
        <label>
          <span className="we-sr-only">{t('rightPanel.inspector.inputTypeAria', { name })}</span>
          <SelectControl  value={shape.type} onChange={(event) => onTypeChange(event.target.value as WorkflowInputSchemaShape['type'])}>
            {INPUT_TYPES.slice(0, form ? 3 : 5).map(type => <option key={type} value={type}>{t(`rightPanel.inspector.inputType.${type}`)}</option>)}
          </SelectControl>
        </label>
        <label className="checkbox-row we-workflow-io__required">
          <input
            type="checkbox"
            checked={required}
            aria-label={t('rightPanel.inspector.requiredAria', { name })}
            onChange={(event) => onRequiredChange(event.target.checked)}
          />
          {t('rightPanel.inspector.required')}
        </label>
        <button type="button" className="icon-button" onClick={onRemove} aria-label={t('rightPanel.inspector.removeInput', { name })}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      <TextInput
        className="we-workflow-io__description"
        value={shape.description ?? ''}
        onChange={(event) => onDescriptionChange(event.target.value)}
        placeholder={t('rightPanel.inspector.inputDescriptionPlaceholder')}
        aria-label={t('rightPanel.inspector.inputDescriptionAria', { name })}
      />
      {!form && <InputDefaultField name={name} shape={shape} onChange={onDefaultChange} />}
      {nameError && <p id={nameErrorId} className="we-workflow-io__error" role="alert">{t('rightPanel.inspector.nameConflict')}</p>}
    </div>
  )
}

/**
 * Declared default for one input — the value a run uses when the caller omits
 * the field, and what makes a trigger-started workflow runnable at all.
 *
 * The control is typed to the field so the stored value keeps its JSON type: a
 * number field must not persist `"12"`, which would fail
 * `input_default_type_mismatch` at save. Object/array defaults are deliberately
 * not editable inline — the same posture the rest of this editor takes toward
 * nested shapes, which it preserves rather than flattening.
 */
function InputDefaultField({ name, shape, onChange }: {
  name: string
  shape: WorkflowInputSchemaShape
  onChange: (value: unknown) => void
}) {
  const { t } = useT()
  if (shape.type === 'object' || shape.type === 'array') return null

  const label = t('rightPanel.inspector.inputDefaultAria', { name })
  if (shape.type === 'boolean') {
    // Three states: unset (no default), true, false — a bare checkbox could not
    // express "no default declared".
    const value = shape.default === undefined ? '' : shape.default ? 'true' : 'false'
    return (
      <label className="we-workflow-io__default">
        <span className="we-sr-only">{label}</span>
        <SelectControl

          value={value}
          aria-label={label}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
        >
          <option value="">{t('rightPanel.inspector.inputDefaultNone')}</option>
          <option value="true">{t('rightPanel.inspector.inputDefaultTrue')}</option>
          <option value="false">{t('rightPanel.inspector.inputDefaultFalse')}</option>
        </SelectControl>
      </label>
    )
  }

  if (shape.type === 'number') {
    return (
      <NumberDefaultField
        label={label}
        value={typeof shape.default === 'number' ? shape.default : undefined}
        placeholder={t('rightPanel.inspector.inputDefaultPlaceholder')}
        onChange={onChange}
      />
    )
  }

  return (
    <label className="we-workflow-io__default">
      <span className="we-sr-only">{label}</span>
      <TextInput

        type="text"
        value={shape.default === undefined ? '' : String(shape.default)}
        placeholder={t('rightPanel.inspector.inputDefaultPlaceholder')}
        aria-label={label}
        onChange={(event) => {
          const next = event.target.value
          onChange(next === '' ? undefined : next)
        }}
      />
    </label>
  )
}

const FINITE_NUMBER_DRAFT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Keep the operator's in-progress number text separate from the normalized
 * workflow value. Browser number inputs erase useful intermediate states such
 * as `-` and `1e`; a decimal keyboard hint plus explicit finite parsing lets
 * those states remain editable without ever persisting NaN or a string.
 */
function NumberDefaultField({ label, value, placeholder, onChange }: {
  label: string
  value?: number
  placeholder: string
  onChange: (value: unknown) => void
}) {
  const externalValue = value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(externalValue)
  const focusedRef = useRef(false)
  const draftIsValid = draft === '' || (FINITE_NUMBER_DRAFT.test(draft) && Number.isFinite(Number(draft)))

  useEffect(() => {
    if (!focusedRef.current) setDraft(externalValue)
  }, [externalValue])

  return (
    <label className="we-workflow-io__default">
      <span className="we-sr-only">{label}</span>
      <TextInput

        type="text"
        inputMode="decimal"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={draftIsValid ? undefined : true}
        onFocus={() => { focusedRef.current = true }}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          if (next === '') {
            onChange(undefined)
            return
          }
          if (FINITE_NUMBER_DRAFT.test(next)) {
            const parsed = Number(next)
            if (Number.isFinite(parsed)) onChange(parsed)
          }
        }}
        onBlur={() => {
          focusedRef.current = false
          setDraft(value === undefined ? '' : String(value))
        }}
      />
    </label>
  )
}

type WorkflowIoEditorProps = {
  workflowId: string
  inputs?: WorkflowDefinition['inputs']
  outputs?: WorkflowDefinition['outputs']
  templatePolicy?: WorkflowDefinition['templatePolicy']
  onChangeInputs: (inputs: WorkflowDefinition['inputs']) => void
  onChangeOutputs: (outputs: WorkflowDefinition['outputs']) => void
  onChangeTemplatePolicy: (policy: WorkflowDefinition['templatePolicy']) => void
}
export function WorkflowIoEditor({
  workflowId,
  inputs,
  outputs,
  templatePolicy,
  onChangeInputs,
  onChangeOutputs,
  onChangeTemplatePolicy,
}: WorkflowIoEditorProps) {
  const { t } = useT()
  const outputEntries = Object.entries(outputs ?? {})

  const addOutput = () => {
    const name = nextName('result', Object.keys(outputs ?? {}))
    onChangeOutputs({ ...outputs, [name]: '' })
  }

  const renameOutput = (from: string, rawTo: string): boolean => {
    const to = rawTo.trim()
    if (!to || (to !== from && Object.hasOwn(outputs ?? {}, to))) return false
    if (to === from) return true
    const next = Object.fromEntries(outputEntries.map(([name, template]) => [name === from ? to : name, template]))
    onChangeOutputs(next)
    return true
  }

  const updateOutput = (name: string, template: string) => onChangeOutputs({ ...outputs, [name]: template })
  const removeOutput = (name: string) => {
    const next = { ...outputs }
    delete next[name]
    onChangeOutputs(Object.keys(next).length > 0 ? next : undefined)
  }

  return (
    <section className="we-card we-workflow-io" data-testid="workflow-io-card">
      <div className="section-kicker">{t('rightPanel.inspector.ioKicker')}</div>
      <h3>{t('rightPanel.inspector.ioTitle')}</h3>
      <p className="helper-text">{t('rightPanel.inspector.ioHelper')}</p>

      <div className="we-workflow-io__section" data-testid="workflow-template-policy">
        <div className="we-workflow-io__heading">
          <div>
            <strong>{t('rightPanel.inspector.templatePolicyLabel')}</strong>
            <p>{t('rightPanel.inspector.templatePolicyHelper')}</p>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={templatePolicy === 'strict'}
              onChange={(event) => onChangeTemplatePolicy(event.target.checked ? 'strict' : undefined)}
            />
            {t('rightPanel.inspector.templatePolicyStrict')}
          </label>
        </div>
        <p className="we-workflow-io__empty" role="status">
          {t(templatePolicy === 'strict'
            ? 'rightPanel.inspector.templatePolicyStrictStatus'
            : 'rightPanel.inspector.templatePolicyLenientStatus')}
        </p>
      </div>

      <SchemaFieldsEditor
        scope={workflowId}
        schema={inputs}
        onChange={onChangeInputs}
      />

      <div className="we-workflow-io__section" data-testid="workflow-outputs-editor">
        <div className="we-workflow-io__heading">
          <div>
            <strong>{t('rightPanel.inspector.outputsLabel')}</strong>
            <p>{t('rightPanel.inspector.outputsHelper')}</p>
          </div>
          <button type="button" className="small-command" onClick={addOutput} data-testid="workflow-output-add">
            <Plus size={13} aria-hidden="true" />
            {t('rightPanel.inspector.addOutput')}
          </button>
        </div>
        {outputEntries.length === 0 ? (
          <p className="we-workflow-io__empty">{t('rightPanel.inspector.noOutputs')}</p>
        ) : (
          <div className="we-workflow-io__rows">
            {outputEntries.map(([name, template]) => (
              <OutputRow
                key={`${workflowId}:${name}`}
                name={name}
                template={template}
                onRename={(next) => renameOutput(name, next)}
                onTemplateChange={(next) => updateOutput(name, next)}
                onRemove={() => removeOutput(name)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
function OutputRow({ name, template, onRename, onTemplateChange, onRemove }: {
  name: string
  template: string
  onRename: (name: string) => boolean
  onTemplateChange: (template: string) => void
  onRemove: () => void
}) {
  const { t } = useT()
  const { nameErrorId, nameDraft, setNameDraft, nameError, setNameError, commitName } = useNameDraft(name, onRename)
  return (
    <div className="we-workflow-io__row" data-testid={`workflow-output-${name}`}>
      <div className="we-workflow-io__row-main we-workflow-io__row-main--output">
        <label>
          <span className="we-sr-only">{t('rightPanel.inspector.outputNameAria', { name })}</span>
          <TextInput
            value={nameDraft}
            maxLength={80}
            aria-invalid={nameError || undefined}
            aria-describedby={nameError ? nameErrorId : undefined}
            onChange={(event) => { setNameDraft(event.target.value); setNameError(false) }}
            onBlur={commitName}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </label>
        <TextInput
          className="we-workflow-io__template"
          value={template}
          onChange={(event) => onTemplateChange(event.target.value)}
          placeholder={t('rightPanel.inspector.outputTemplatePlaceholder')}
          aria-label={t('rightPanel.inspector.outputTemplateAria', { name })}
        />
        <button type="button" className="icon-button" onClick={onRemove} aria-label={t('rightPanel.inspector.removeOutput', { name })}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      {nameError && <p id={nameErrorId} className="we-workflow-io__error" role="alert">{t('rightPanel.inspector.nameConflict')}</p>}
    </div>
  )
}
