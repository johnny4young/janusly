/**
 * Bounded operator-guidance primitives shared by API, data, and web.
 *
 * Guidance is a preference layer for AI authoring and recovery. It is never
 * a secret store, authorization input, or replacement for the system prompt.
 */

import { utf8ByteLength } from './utf8'
import { scrubSecretShapes } from './error-signature'

/** Maximum UTF-8 bytes stored for either the org or workflow scope. */
export const AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES = 8 * 1024

/** Secret families that free-form guidance must never persist or send to an LLM. */
const OPERATOR_GUIDANCE_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-(?:(?:ant|proj)-)?[A-Za-z0-9_-]{20,}/gi,
  /ya29\.[A-Za-z0-9._-]{20,}/gi,
  /(?:postgres(?:ql)?|mysql|mariadb|redis(?:s)?):\/\/[^\s"'<>]+/gi,
  /https?:\/\/[^\s:/@"'<>]+:[^@\s/"'<>]+@[^\s"'<>]+/gi,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
]

/** Replace every guidance-specific credential shape with a redaction marker. */
export function scrubOperatorGuidanceSecrets(value: string): string {
  let scrubbed = scrubSecretShapes(value)
  for (const pattern of OPERATOR_GUIDANCE_SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[redacted]')
  }
  return scrubbed
}

/** Write-time detector shared by organization and workflow guidance validators. */
export function containsOperatorGuidanceSecret(value: string): boolean {
  return scrubOperatorGuidanceSecrets(value) !== value
}

/** Audit-safe descriptor: records presence and size, never guidance content. */
export function summarizeOperatorGuidance(value: unknown): { configured: boolean; bytes: number } {
  const guidance = typeof value === 'string' ? value : ''
  return {
    configured: guidance.trim().length > 0,
    bytes: utf8ByteLength(guidance),
  }
}

/** UTF-8-safe prefix truncation that never returns a split replacement rune. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return value
  return new TextDecoder('utf-8', { fatal: false }).decode(encoded.slice(0, maxBytes)).replace(/\uFFFD$/, '')
}
