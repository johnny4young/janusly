/**
 * Compact, paste-ready recovery context derived from an already visible DLQ
 * entry. The helper deliberately extracts one message instead of copying raw
 * JSON so escalation channels receive a useful single line.
 *
 * Used by:
 * - `web/src/components/DeadLettersPanel.tsx`
 */

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
