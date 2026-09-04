import { t as runtimeT } from '../i18n/runtime'
import type { WorkflowInputSchemaShape } from '../types'
import { inputDisplayLabel } from './input-display-label'
import { isRecord } from '../lib/guards'

export { inputDisplayLabel } from './input-display-label'

export type RunInputFormState = Record<string, unknown>
export type RunInputErrorMap = Record<string, string>
export type RunInputPropertyEntry = [string, WorkflowInputSchemaShape]

/** Keep required inputs ahead of optional ones after JSONB normalizes object key order. */
export function orderedRunInputEntries(schema: WorkflowInputSchemaShape): RunInputPropertyEntry[] {
  const required = schema.required ?? []
  return Object.entries(schema.properties ?? {}).sort(([leftKey], [rightKey]) => (
    Number(required.includes(rightKey)) - Number(required.includes(leftKey))
    || inputDisplayLabel(leftKey).localeCompare(inputDisplayLabel(rightKey))
  ))
}

export function initialRunInputState(
  schema: WorkflowInputSchemaShape,
  initialValue?: unknown,
): RunInputFormState {
  if (schema.type === 'object' && schema.properties) {
    const obj: RunInputFormState = {}
    const effectiveValue = initialValue !== undefined ? initialValue : schema.default
    const supplied = isRecord(effectiveValue) ? effectiveValue : {}
    for (const [key, child] of Object.entries(schema.properties)) {
      obj[key] = initialLeafValue(child, supplied[key])
    }
    return obj
  }
  return { __root__: initialLeafValue(schema, initialValue) }
}

function initialLeafValue(schema: WorkflowInputSchemaShape, supplied?: unknown): unknown {
  const effectiveValue = supplied !== undefined ? supplied : schema.default
  if (effectiveValue !== undefined) {
    if (schema.type === 'object' && schema.properties && isRecord(effectiveValue)) {
      const nested: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(schema.properties)) {
        nested[key] = initialLeafValue(child, effectiveValue[key])
      }
      return nested
    }
    return effectiveValue
  }
  if (schema.type === 'object' && schema.properties) {
    const nested: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(schema.properties)) {
      nested[key] = initialLeafValue(child)
    }
    return nested
  }
  return ''
}

export function getRunInputValue(state: RunInputFormState, path: string): unknown {
  if (!path) return state.__root__
  const segments = path.split('.')
  let cursor: unknown = state
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

export function setRunInputValue(
  state: RunInputFormState,
  path: string,
  value: unknown,
): RunInputFormState {
  if (!path) return { ...state, __root__: value }
  const segments = path.split('.')
  const next: RunInputFormState = { ...state }
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

export function parseRunInputState(
  state: RunInputFormState,
  schema: WorkflowInputSchemaShape,
): { value: unknown; errors: RunInputErrorMap } {
  if (schema.type === 'object' && schema.properties) {
    const errors: RunInputErrorMap = {}
    const value = parseObject(schema, state, '', errors)
    return { value, errors }
  }
  const errors: RunInputErrorMap = {}
  const value = parseLeaf(schema, state.__root__, '', errors, schema.default === undefined)
  return { value, errors }
}

function parseObject(
  schema: WorkflowInputSchemaShape,
  raw: unknown,
  path: string,
  errors: RunInputErrorMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (schema.type !== 'object' || !schema.properties) return out
  const requiredSet = new Set(schema.required ?? [])
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  for (const [key, child] of Object.entries(schema.properties)) {
    const childPath = path ? `${path}.${key}` : key
    const isRequired = requiredSet.has(key)
    if (child.type === 'object' && child.properties) {
      const nested = parseObject(child, obj[key], childPath, errors)
      if (isRequired && Object.keys(nested).length === 0) {
        errors[childPath] = requiredError(childPath)
      }
      if (Object.keys(nested).length > 0) out[key] = nested
      continue
    }
    const parsed = parseLeaf(child, obj[key], childPath, errors, isRequired)
    if (parsed !== undefined) out[key] = parsed
  }
  return out
}

function parseLeaf(
  schema: WorkflowInputSchemaShape,
  raw: unknown,
  path: string,
  errors: RunInputErrorMap,
  required: boolean,
): unknown {
  if (schema.type === 'string') {
    const text = typeof raw === 'string' ? raw : ''
    if (!text) {
      if (required) errors[path] = requiredError(path)
      return undefined
    }
    return text
  }
  if (schema.type === 'number') {
    if (raw === '' || raw === undefined || raw === null) {
      if (required) errors[path] = requiredError(path)
      return undefined
    }
    const num = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(num)) {
      errors[path] = runtimeT('runInput.error.notNumber', { label: inputDisplayLabel(path) })
      return undefined
    }
    return num
  }
  if (schema.type === 'boolean') {
    if (raw !== true && raw !== false) {
      if (required) errors[path] = requiredError(path)
      return undefined
    }
    return raw
  }
  if (schema.type === 'array') {
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (!trimmed) {
        if (required) errors[path] = requiredError(path)
        return undefined
      }
      try {
        const parsed = JSON.parse(trimmed)
        if (!Array.isArray(parsed)) {
          errors[path] = runtimeT('runInput.error.notArray', { label: inputDisplayLabel(path) })
          return undefined
        }
        return parsed
      } catch {
        errors[path] = runtimeT('runInput.error.notJson', { label: inputDisplayLabel(path) })
        return undefined
      }
    }
    if (Array.isArray(raw)) return raw
    if (required) errors[path] = requiredError(path)
    return undefined
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) {
      if (required) errors[path] = requiredError(path)
      return undefined
    }
    try {
      return JSON.parse(trimmed)
    } catch {
      errors[path] = runtimeT('runInput.error.notJson', { label: inputDisplayLabel(path) })
      return undefined
    }
  }
  return raw
}

function requiredError(path: string): string {
  return runtimeT('runInput.error.required', { label: inputDisplayLabel(path) })
}

export function splitRunInputServerErrors(
  raw: string[],
  schema: WorkflowInputSchemaShape,
): { mappedServerErrors: RunInputErrorMap; formLevelServerErrors: string[] } {
  const mapped: RunInputErrorMap = {}
  const formLevel: string[] = []
  const knownPaths = collectFieldPaths(schema, '')

  for (const message of raw) {
    if (!message.startsWith('$.') && message !== '$') {
      formLevel.push(message)
      continue
    }
    const stripped = message.replace(/^\$\.?/, '')
    const firstSpace = stripped.indexOf(' ')
    const pathSegment = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace)
    const reason = firstSpace === -1 ? stripped : stripped.slice(firstSpace + 1)
    const fieldPath = matchKnownPath(pathSegment, knownPaths) ?? pathSegment
    if (!fieldPath) {
      const fallback = reason || stripped || message
      if (fallback) formLevel.push(fallback)
      continue
    }
    const display = reason
      ? runtimeT('runInput.error.serverPrefix', {
          label: inputDisplayLabel(fieldPath),
          reason,
        })
      : stripped
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
  let best: string | undefined
  for (const candidate of knownPaths) {
    if (segment === candidate || segment.startsWith(`${candidate}.`) || segment.startsWith(`${candidate}[`)) {
      if (!best || candidate.length > best.length) best = candidate
    }
  }
  return best
}
