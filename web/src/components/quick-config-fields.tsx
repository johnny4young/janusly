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
import { FormField, type FormControlProps } from './ui/Form'

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

function mergeDescribedBy(controlProps: FormControlProps, externalId?: string) {
  return [controlProps['aria-describedby'], externalId].filter(Boolean).join(' ') || undefined
}

export function TextConfigField({ scope, label, value, onChange, describedBy }: { scope: string; label: string; value: string; onChange: (value: string) => void; describedBy?: string }) {
  const id = fieldId(scope, label)
  return (
    <FormField id={id} label={label}>
      {controlProps => (
        <input
          {...controlProps}
          value={value}
          aria-describedby={mergeDescribedBy(controlProps, describedBy)}
          onChange={event => onChange(event.target.value)}
        />
      )}
    </FormField>
  )
}

export function NumberConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: number; onChange: (value: number) => void }) {
  const id = fieldId(scope, label)
  return (
    <FormField id={id} label={label}>
      {controlProps => (
        <input {...controlProps} type="number" min={1} value={value} onChange={event => onChange(Number(event.target.value) || 1)} />
      )}
    </FormField>
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
    <FormField id={id} label={label}>
      {controlProps => (
        <input
          {...controlProps}
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
      )}
    </FormField>
  )
}

export function TextareaConfigField({ scope, label, value, onChange }: { scope: string; label: string; value: string; onChange: (value: string) => void }) {
  const id = fieldId(scope, label)
  return (
    <FormField id={id} label={label}>
      {controlProps => (
        <textarea {...controlProps} className="ui-config-code ui-config-code--short" value={value} onChange={event => onChange(event.target.value)} />
      )}
    </FormField>
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
    <FormField id={id} label={label} error={error}>
      {controlProps => (
        <textarea
          {...controlProps}
          className="ui-config-code ui-config-code--short"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => {
            try {
              onChange(JSON.parse(event.target.value))
              setError(null)
            } catch {
              setError(t('rightPanel.jsonField.invalidJson'))
            }
          }}
        />
      )}
    </FormField>
  )
}

export function OptionalJsonConfigField({
  scope,
  label,
  value,
  onChange,
  describedBy,
  placeholder,
}: {
  scope: string
  label: string
  value: unknown
  onChange: (value: unknown | undefined) => void
  describedBy?: string
  placeholder?: string
}) {
  const { t } = useT()
  const [error, setError] = useState<string | null>(null)
  const serializedValue = value === undefined ? '' : JSON.stringify(value, null, 2)
  const [draft, setDraft] = useState(serializedValue)
  const id = fieldId(scope, label)

  useEffect(() => {
    setDraft((current) => {
      if (current.trim() === '' && value === undefined) return current
      try {
        return JSON.stringify(JSON.parse(current)) === JSON.stringify(value)
          ? current
          : serializedValue
      } catch {
        return serializedValue
      }
    })
    setError(null)
  }, [serializedValue, value])

  return (
    <FormField id={id} label={label} error={error}>
      {controlProps => (
        <textarea
          {...controlProps}
          className="ui-config-code ui-config-code--short"
          value={draft}
          placeholder={placeholder}
          aria-describedby={mergeDescribedBy(controlProps, describedBy)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => {
            const next = event.target.value.trim()
            if (!next) {
              if (value !== undefined) onChange(undefined)
              setError(null)
              return
            }
            try {
              onChange(JSON.parse(next))
              setError(null)
            } catch {
              setError(t('rightPanel.jsonField.invalidJson'))
            }
          }}
        />
      )}
    </FormField>
  )
}
