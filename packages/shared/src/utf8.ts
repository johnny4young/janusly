/**
 * Zero-dependency UTF-8 byte measurement shared by browser and Node callers.
 *
 * Used by schema refinements and bounded prompt helpers that must not pull
 * unrelated Zod schema modules into browser chunks.
 */

const UTF8_ENCODER = new TextEncoder()

/** Compute a string's encoded UTF-8 byte length without Node globals. */
export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength
}
