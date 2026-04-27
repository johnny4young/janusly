const failureKeys = new Set(['error', 'errors', 'exception', 'failure', 'failed'])
const failedStatuses = new Set(['error', 'errored', 'failed', 'failure'])

export function hasFailureSignal(value: unknown): boolean {
  if (value == null) return false

  if (typeof value === 'string') {
    return /^\s*(error|failed|failure|exception)\b/i.test(value)
      || /\b(status|state)\s*[:=]\s*(error|failed|failure)\b/i.test(value)
  }

  if (typeof value === 'boolean' || typeof value === 'number') return false

  if (Array.isArray(value)) return value.some(hasFailureSignal)

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase()

      if (failureKeys.has(normalizedKey)) {
        if (Array.isArray(entry)) {
          if (entry.length > 0) return true
          continue
        }
        if (entry) return true
      }

      if ((normalizedKey === 'status' || normalizedKey === 'state') && typeof entry === 'string') {
        if (failedStatuses.has(entry.toLowerCase())) return true
      }

      if ((normalizedKey === 'ok' || normalizedKey === 'success') && entry === false) return true
      if (hasFailureSignal(entry)) return true
    }
  }

  return false
}
