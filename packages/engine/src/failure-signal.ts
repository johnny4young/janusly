/**
 * Heuristic that walks an arbitrary value and returns true if it looks like
 * a failure response. Used by the `agent_reflection` node + the agent loop's
 * reflection step to decide whether to retry vs accept a tool result.
 *
 * Used by `node-executors/agents.ts` (`agent_reflection` executor + `runAgentLoop`).
 *
 * Invariants:
 * - Conservative on the "did this fail" side — false positives (claim
 *   failure on success) are preferred to false negatives (silently accept
 *   an error). Reflective retries are cheap; missed failures are not.
 */

const failureKeys = new Set(['error', 'errors', 'exception', 'failure', 'failed'])
const failedStatuses = new Set(['error', 'errored', 'failed', 'failure'])

/** Recursive failure-shape detector: strings, status fields, error keys, and nested values. */
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
