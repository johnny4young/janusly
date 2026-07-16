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

export function TextConfigField({ scope, label, value, onChange, describedBy }: { scope: string; label: string; value: string; onChange: (value: string) => void; describedBy?: string }) {
  const id = fieldId(scope, label)
  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} className="text-field" value={value} aria-describedby={describedBy} onChange={event => onChange(event.target.value)} />
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

/** Number field that preserves an absent optional config value until the operator sets one. */
export function OptionalNumberConfigField({
  scope,
  label,
  value,
  onChange,
  min = 1,
  max,
  step = 1,
  placeholder,
}: {
  scope: string
  label: string
  value: number | null
  onChange: (value: number | undefined) => void
  min?: number
  max?: number
  step?: number | 'any'
  placeholder?: string
}) {
  const id = fieldId(scope, label)
  const [draft, setDraft] = useState(() => value === null ? '' : String(value))

  useEffect(() => {
    setDraft(value === null ? '' : String(value))
  }, [scope, value])

  // Clamp on BLUR, not per keystroke: clamping mid-typing mangles multi-digit
  // entry (with min=2, typing "10" becomes 1 → clamped "2" → "20").
  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="text-field"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft.trim() === '') {
            if (value !== null) onChange(undefined)
            return
          }
          const parsed = Number(draft)
          if (!Number.isFinite(parsed)) {
            setDraft(value === null ? '' : String(value))
            return
          }
          const normalized = step === 'any' ? parsed : Math.round(parsed / step) * step
          const bounded = Math.max(min, Math.min(max ?? Number.POSITIVE_INFINITY, normalized))
          setDraft(String(bounded))
          if (bounded !== value) onChange(bounded)
        }}
      />
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
          } catch {
            setError(t('rightPanel.jsonField.invalidJson') as string)
          }
        }}
      />
      {error && <div className="issue issue-error">{error}</div>}
    </div>
  )
}
