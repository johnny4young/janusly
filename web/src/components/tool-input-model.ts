import type { JsonObject, ToolInputFieldSchema } from '../types'

export type ToolInputDraftError = 'required' | 'number' | 'integer' | 'boolean' | 'json' | 'option'

export type ParsedToolInputDraft =
  | { ok: true; remove: true }
  | { ok: true; remove?: false; value: unknown }
  | { ok: false; error: ToolInputDraftError }

const COMPLETE_TEMPLATE = /^\s*\{\{[\s\S]+\}\}\s*$/

export function isToolInputObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function formatToolInputDraft(value: unknown, kind: ToolInputFieldSchema['kind']): string {
  if (value === undefined) return ''
  if (typeof value === 'string' && (kind !== 'json' || COMPLETE_TEMPLATE.test(value))) return value
  if (kind !== 'json' && (typeof value === 'number' || typeof value === 'boolean')) {
    return String(value)
  }
  return JSON.stringify(value, null, 2)
}

export function parseToolInputDraft(
  field: ToolInputFieldSchema,
  draft: string,
): ParsedToolInputDraft {
  const trimmed = draft.trim()
  if (!trimmed) return field.required ? { ok: false, error: 'required' } : { ok: true, remove: true }
  if (field.kind === 'string') {
    if (field.options?.length && !field.options.includes(draft) && !COMPLETE_TEMPLATE.test(trimmed)) {
      return { ok: false, error: 'option' }
    }
    return { ok: true, value: draft }
  }
  if (COMPLETE_TEMPLATE.test(trimmed)) return { ok: true, value: trimmed }

  if (field.kind === 'number' || field.kind === 'integer') {
    const value = Number(trimmed)
    if (!Number.isFinite(value)) return { ok: false, error: field.kind }
    if (field.kind === 'integer' && !Number.isInteger(value)) return { ok: false, error: 'integer' }
    return { ok: true, value }
  }

  if (field.kind === 'boolean') {
    if (trimmed === 'true') return { ok: true, value: true }
    if (trimmed === 'false') return { ok: true, value: false }
    return { ok: false, error: 'boolean' }
  }

  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    return { ok: false, error: 'json' }
  }
}

export function applyToolInputDraft(
  input: JsonObject,
  field: ToolInputFieldSchema,
  parsed: Exclude<ParsedToolInputDraft, { ok: false }>,
): JsonObject {
  if (parsed.remove) {
    const { [field.name]: _removed, ...rest } = input
    return rest
  }
  return { ...input, [field.name]: parsed.value }
}
