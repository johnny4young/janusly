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
