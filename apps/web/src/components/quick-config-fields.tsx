/**
 * Form field primitives shared by `QuickConfigEditor` and
 * `McpToolConfigField`. Pre-extraction these lived inside RightPanel.tsx
 * alongside both consumers; the move out lets each consumer live in its
 * own file without circular imports.
 *
 * Used by:
 * - `QuickConfigEditor.tsx`
 * - `McpToolConfigField.tsx`
 */

import { useEffect, useState } from 'react'
import type { JsonObject } from '../types'
import { useT } from '../i18n'

export function fieldId(scope: string, label: string) {
  return `${scope}-${label.toLowerCase().replaceAll(' ', '-')}`
}

export function readConfigString(config: JsonObject, key: string) {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

export function readConfigNumber(config: JsonObject, key: string) {
  const value = config[key]
  return typeof value === 'number' ? value : null
}

export function asJsonObject(value: unknown) {
  return value && typeof value === 'object' ? value : {}
}

export function TextConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: string; onChange: (value: string) => void }) {
  const id = fieldId(scope, label)
  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} className="text-field" value={value} onChange={event => onChange(event.target.value)} />
    </div>
  )
}

export function NumberConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: number; onChange: (value: number) => void }) {
  const id = fieldId(scope, label)
  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} className="text-field" type="number" min={1} value={value} onChange={event => onChange(Number(event.target.value) || 1)} />
    </div>
  )
}

export function TextareaConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: string; onChange: (value: string) => void }) {
  const id = fieldId(scope, label)
  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <textarea id={id} className="code-field code-field-short" value={value} onChange={event => onChange(event.target.value)} />
    </div>
  )
}

export function JsonConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: unknown; onChange: (value: unknown) => void }) {
  const { t } = useT()
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const id = fieldId(scope, label)

  useEffect(() => {
    const next = JSON.stringify(value ?? {}, null, 2)
    setDraft((current) => {
      try {
        return JSON.stringify(JSON.parse(current)) === JSON.stringify(value ?? {}) ? current : next
      } catch {
        return next
      }
    })
  }, [value])

  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="code-field code-field-short"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          try {
            onChange(JSON.parse(event.target.value))
            setError(null)
          } catch (jsonError) {
            setError(jsonError instanceof Error ? jsonError.message : (t('rightPanel.jsonField.invalidJson') as string))
          }
        }}
      />
      {error && <div className="issue issue-error">{error}</div>}
    </div>
  )
}
