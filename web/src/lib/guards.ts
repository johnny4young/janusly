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
