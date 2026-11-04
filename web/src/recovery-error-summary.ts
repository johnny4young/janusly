/**
 * Readable recovery context derived from an already visible DLQ entry: a
 * paste-ready single line for escalation channels, and the digest shown above
 * the raw error JSON in the failure detail.
 *
 * Used by:
 * - `web/src/components/DeadLettersPanel.tsx`
 * - `web/src/components/ActivityRecoveryDetail.tsx`
 * - `web/src/components/recovery/RecoveryErrorBlock.tsx`
 */

import {
  normalizeErrorSignature,
  scrubSecretShapes,
  type ErrorCategory,
} from './lib/error-signature'

type RecoveryErrorSummaryInput = {
  workflowName?: string | null
  nodeId: string
  nodeType?: string | null
  errorJson: unknown
  createdAt?: string | null
  runId: string
}

type RecoveryErrorSummaryFallbacks = {
  workflow: string
  nodeType: string
  error: string
  timestamp: string
}

const MESSAGE_KEYS = ['message', 'error', 'reason', 'detail'] as const

function compactText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function extractErrorMessage(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') return compactText(value) || null
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return null

  const record = value as Record<string, unknown>
  for (const key of MESSAGE_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return compactText(candidate)
  }
  for (const key of MESSAGE_KEYS) {
    const nested = extractErrorMessage(record[key], depth + 1)
    if (nested) return nested
  }
  return null
}

function normalizeTimestamp(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** Build `workflow · node(type) · message · timestamp · runId`. */
export function buildRecoveryErrorSummary(
  input: RecoveryErrorSummaryInput,
  fallbacks: RecoveryErrorSummaryFallbacks,
): string {
  const workflow = input.workflowName?.trim() ? compactText(input.workflowName) : fallbacks.workflow
  const nodeType = input.nodeType?.trim() ? compactText(input.nodeType) : fallbacks.nodeType
  const message = extractErrorMessage(input.errorJson) ?? fallbacks.error
  const timestamp = normalizeTimestamp(input.createdAt, fallbacks.timestamp)
  return `${workflow} · ${input.nodeId} (${nodeType}) · ${message} · ${timestamp} · ${input.runId}`
}

/** Facts for the failure detail; the view maps the codes to localized copy. */
export type RecoveryErrorDigest = {
  /** The unresolvable host, when the failure is DNS and names one. */
  dnsHost: string | null
  message: string | null
  /** Null hides the cause chip: "Other" would add nothing to the summary. */
  category: Exclude<ErrorCategory, 'unknown'> | null
  causeDetail: 'DNS' | number | null
  /** Null hides the retry chip when the error gives no basis to claim either way. */
  retryable: boolean | null
}

const DNS_HOST_PATTERN = /(?:\blookup\s+(?!failed\b)|\b(?:ENOTFOUND|EAI_AGAIN)\s+|any\s+address:\s*)([\w.-]+)(?=$|:|\s+on\s)/i

function causeFacts(
  category: ErrorCategory,
  signature: string,
  message: string,
): Pick<RecoveryErrorDigest, 'causeDetail' | 'retryable'> {
  switch (category) {
    case 'network_timeout':
      return signature.startsWith('DNS')
        ? { causeDetail: 'DNS', retryable: /EAI_AGAIN|misbehaving|temporary/i.test(message) }
        : { causeDetail: null, retryable: true }
    case 'http_error':
    case 'ai_provider': {
      const status = Number(signature.match(/^HTTP (\d+)/)?.[1])
      return status
        ? { causeDetail: status, retryable: status >= 500 || status === 408 || status === 429 }
        : { causeDetail: null, retryable: /\brate\b/i.test(signature) }
    }
    case 'unknown':
      return { causeDetail: null, retryable: null }
    default:
      return { causeDetail: null, retryable: false }
  }
}

/** Classify with the cluster normalizer so the detail and its cluster agree. */
export function describeRecoveryError(errorJson: unknown, nodeType?: string | null): RecoveryErrorDigest {
  const { signature, category } = normalizeErrorSignature(errorJson, { nodeType: nodeType ?? undefined })
  const raw = extractErrorMessage(errorJson)
  const message = raw && scrubSecretShapes(raw)
  const facts = causeFacts(category, signature, message ?? '')
  const known = category !== 'unknown'
  return {
    ...facts,
    // Read from the scrubbed text, so a secret-shaped host cannot match.
    dnsHost: facts.causeDetail === 'DNS' ? message?.match(DNS_HOST_PATTERN)?.[1] ?? null : null,
    message: message ?? (known ? signature : null),
    category: known ? category : null,
    // The engine refuses to auto-retry these: external effects may already have happened.
    retryable: (errorJson as { writeSide?: unknown } | null)?.writeSide === true ? false : facts.retryable,
  }
}
