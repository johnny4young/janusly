import type {
  BulkReplayResult,
  BulkResolveResult,
  DeadLetter,
} from './dead-letter-types'

export const BULK_ERROR_PREVIEW = 6

export function isBulkResolveResult(value: unknown): value is BulkResolveResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BulkResolveResult>
  return typeof candidate.resolved === 'number'
    && typeof candidate.failed === 'number'
    && Array.isArray(candidate.errors)
}

export function isBulkReplayResult(value: unknown): value is BulkReplayResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BulkReplayResult>
  return typeof candidate.replayed === 'number'
    && typeof candidate.failed === 'number'
    && Array.isArray(candidate.errors)
}

export function triageQueueSignature(items: DeadLetter[]): string {
  return items.map((item) => `${item.id}:${item.status}`).join('|')
}

export function deadLetterRowTone(
  status: DeadLetter['status'],
): 'danger' | 'success' | 'cobalt' {
  if (status === 'open') return 'danger'
  if (status === 'replayed') return 'success'
  return 'cobalt'
}
