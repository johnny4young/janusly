/**
 * Direct editor for a workflow's top-level input contract and output templates.
 * Nested field schemas are preserved until the operator explicitly changes that
 * field's type; non-object root schemas stay read-only to avoid destructive
 * flattening.
 *
 * Used by: `InspectorPanel.tsx` when no node or edge is selected.
 */

import { useId, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { WorkflowDefinition, WorkflowInputSchemaShape } from '../types'
import { useT } from '../i18n'

type WorkflowIoEditorProps = {
  workflowId: string
  inputs?: WorkflowDefinition['inputs']
  outputs?: WorkflowDefinition['outputs']
  templatePolicy?: WorkflowDefinition['templatePolicy']
  onChangeInputs: (inputs: WorkflowDefinition['inputs']) => void
  onChangeOutputs: (outputs: WorkflowDefinition['outputs']) => void
  onChangeTemplatePolicy: (policy: WorkflowDefinition['templatePolicy']) => void
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
  const editableInputs = !inputs || inputs.type === 'object'
  const properties = editableInputs ? inputs?.properties ?? {} : {}
  const required = new Set(editableInputs ? inputs?.required ?? [] : [])
  const outputEntries = Object.entries(outputs ?? {})

  const writeInputs = (nextProperties: Record<string, WorkflowInputSchemaShape>, nextRequired: Set<string>) => {
    if (Object.keys(nextProperties).length === 0) {
      onChangeInputs(undefined)
      return
    }
    onChangeInputs({
      ...(inputs?.type === 'object' ? inputs : {}),
      type: 'object',
      properties: nextProperties,
      ...(nextRequired.size > 0 ? { required: [...nextRequired].filter(name => Object.hasOwn(nextProperties, name)) } : { required: undefined }),
    })
  }

  const addInput = () => {
    const name = nextName('input', Object.keys(properties))
    writeInputs({ ...properties, [name]: { type: 'string' } }, required)
  }

  const renameInput = (from: string, rawTo: string): boolean => {
    const to = rawTo.trim()
    if (!to || (to !== from && Object.hasOwn(properties, to))) return false
    if (to === from) return true
    const nextProperties = Object.fromEntries(Object.entries(properties).map(([name, shape]) => [name === from ? to : name, shape]))
    const nextRequired = new Set([...required].map(name => name === from ? to : name))
    writeInputs(nextProperties, nextRequired)
    return true
  }

  const updateInput = (name: string, shape: WorkflowInputSchemaShape) => {
    writeInputs({ ...properties, [name]: shape }, required)
  }

  const removeInput = (name: string) => {
    const nextProperties = { ...properties }
    delete nextProperties[name]
    const nextRequired = new Set(required)
    nextRequired.delete(name)
    writeInputs(nextProperties, nextRequired)
  }

  const toggleRequired = (name: string, checked: boolean) => {
    const nextRequired = new Set(required)
    if (checked) nextRequired.add(name)
    else nextRequired.delete(name)
    writeInputs(properties, nextRequired)
  }

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

      <div className="we-workflow-io__section" data-testid="workflow-inputs-editor">
        <div className="we-workflow-io__heading">
          <div>
            <strong>{t('rightPanel.inspector.inputsLabel')}</strong>
            <p>{t('rightPanel.inspector.inputsHelper')}</p>
          </div>
          {editableInputs && (
            <button type="button" className="small-command" onClick={addInput} data-testid="workflow-input-add">
              <Plus size={13} aria-hidden="true" />
              {t('rightPanel.inspector.addInput')}
            </button>
          )}
        </div>
        {!editableInputs ? (
          <div className="issue issue-warning" role="status">
            {t('rightPanel.inspector.inputRootUnsupported', { type: inputs.type })}
          </div>
        ) : Object.entries(properties).length === 0 ? (
          <p className="we-workflow-io__empty">{t('rightPanel.inspector.noInputs')}</p>
        ) : (
          <div className="we-workflow-io__rows">
            {Object.entries(properties).map(([name, shape]) => (
              <InputRow
                key={`${workflowId}:${name}`}
                name={name}
                shape={shape}
                required={required.has(name)}
                onRename={(next) => renameInput(name, next)}
                onTypeChange={(type) => updateInput(name, shapeForType(type, shape.description))}
                onDescriptionChange={(description) => updateInput(name, { ...shape, description: description || undefined })}
                onRequiredChange={(checked) => toggleRequired(name, checked)}
                onRemove={() => removeInput(name)}
              />
            ))}
          </div>
        )}
      </div>

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

function InputRow({ name, shape, required, onRename, onTypeChange, onDescriptionChange, onRequiredChange, onRemove }: {
  name: string
  shape: WorkflowInputSchemaShape
  required: boolean
  onRename: (name: string) => boolean
  onTypeChange: (type: WorkflowInputSchemaShape['type']) => void
  onDescriptionChange: (description: string) => void
  onRequiredChange: (required: boolean) => void
  onRemove: () => void
}) {
  const { t } = useT()
  const nameErrorId = useId()
  const [nameDraft, setNameDraft] = useState(name)
  const [nameError, setNameError] = useState(false)
  const commitName = () => {
    const accepted = onRename(nameDraft)
    setNameError(!accepted)
    if (accepted) setNameDraft(nameDraft.trim())
  }
  return (
    <div className="we-workflow-io__row" data-testid={`workflow-input-${name}`}>
      <div className="we-workflow-io__row-main">
        <label>
          <span className="we-sr-only">{t('rightPanel.inspector.inputNameAria', { name })}</span>
          <input
            className={`text-field text-field--compact${nameError ? ' text-field--error' : ''}`}
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
          <select className="text-field text-field--compact" value={shape.type} onChange={(event) => onTypeChange(event.target.value as WorkflowInputSchemaShape['type'])}>
            {INPUT_TYPES.map(type => <option key={type} value={type}>{t(`rightPanel.inspector.inputType.${type}`)}</option>)}
          </select>
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
      <input
        className="text-field text-field--compact we-workflow-io__description"
        value={shape.description ?? ''}
        onChange={(event) => onDescriptionChange(event.target.value)}
        placeholder={t('rightPanel.inspector.inputDescriptionPlaceholder')}
        aria-label={t('rightPanel.inspector.inputDescriptionAria', { name })}
      />
      {nameError && <p id={nameErrorId} className="we-workflow-io__error" role="alert">{t('rightPanel.inspector.nameConflict')}</p>}
    </div>
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
  const nameErrorId = useId()
  const [nameDraft, setNameDraft] = useState(name)
  const [nameError, setNameError] = useState(false)
  const commitName = () => {
    const accepted = onRename(nameDraft)
    setNameError(!accepted)
    if (accepted) setNameDraft(nameDraft.trim())
  }
  return (
    <div className="we-workflow-io__row" data-testid={`workflow-output-${name}`}>
      <div className="we-workflow-io__row-main we-workflow-io__row-main--output">
        <label>
          <span className="we-sr-only">{t('rightPanel.inspector.outputNameAria', { name })}</span>
          <input
            className={`text-field text-field--compact${nameError ? ' text-field--error' : ''}`}
            value={nameDraft}
            maxLength={80}
            aria-invalid={nameError || undefined}
            aria-describedby={nameError ? nameErrorId : undefined}
            onChange={(event) => { setNameDraft(event.target.value); setNameError(false) }}
            onBlur={commitName}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </label>
        <input
          className="text-field text-field--compact we-workflow-io__template"
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
