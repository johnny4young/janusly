/**
 * Runtime shape guards shared by every wire-payload reader. Ten components
 * used to carry their own copy, with null handling that drifted between
 * them; `scripts/check-duplicate-guards.mjs` keeps them here.
 */

/** A plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value as a record, or null when it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/** The value as a record, or an empty one when it is not (for optional config blocks). */
export function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** An exact non-negative wire count; never coerce strings or round fractions. */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** A string with at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** A string or explicit null; undefined is rejected. */
export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** A string or an omitted field; null is rejected. */
export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** A string, null or an omitted field. */
export function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === 'string'
}

/** A finite number; NaN and infinities are rejected. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** True when every own key of the record is in the allowed list. */
export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/** A one-argument runtime check, composed by the generated response guards. */
export type Guard = (value: unknown) => boolean

type ShapeGuards = Readonly<Record<string, Guard>>

/** Any JSON value, including an explicit null. */
export function isAny(): boolean {
  return true
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** An exact wire integer; never coerce strings or round fractions. */
export function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isNull(value: unknown): value is null {
  return value === null
}

/** One of the listed JSON primitives, compared strictly. */
export function literal(...values: readonly unknown[]): Guard {
  return (value) => values.includes(value)
}

export function nullable(guard: Guard): Guard {
  return (value) => value === null || guard(value)
}

export function anyOf(...guards: readonly Guard[]): Guard {
  return (value) => guards.some((guard) => guard(value))
}

/**
 * Every guard matches. Kept for the generator even while no manifest schema uses allOf.
 * @public
 */
export function allOf(...guards: readonly Guard[]): Guard {
  return (value) => guards.every((guard) => guard(value))
}

export function arrayOf(guard: Guard): Guard {
  return (value) => Array.isArray(value) && value.every((item) => guard(item))
}

/** A map whose keys are data and whose every value satisfies the guard. */
export function recordOf(guard: Guard): Guard {
  return (value) => isRecord(value) && Object.values(value).every((item) => guard(item))
}

/**
 * An object with every `required` key present and valid, `optional` keys valid
 * when present, and any other key accepted only by `rest` (`true` = open).
 */
export function isShape(value: unknown, required: ShapeGuards, optional: ShapeGuards = {}, rest?: Guard | true): boolean {
  if (!isRecord(value)) return false
  for (const key of Object.keys(required)) {
    if (!Object.hasOwn(value, key) || !required[key]!(value[key])) return false
  }
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(required, key)) continue
    const guard = Object.hasOwn(optional, key) ? optional[key] : rest
    if (guard === undefined || (guard !== true && !guard(value[key]))) return false
  }
  return true
}

export function shape(required: ShapeGuards, optional?: ShapeGuards, rest?: Guard | true): Guard {
  return (value) => isShape(value, required, optional, rest)
}
