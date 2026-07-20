/**
 * Consume-once, session-lifetime handoff for a completed recovery queue.
 *
 * Unlike navigation focus requests, this transient success moment must not
 * survive a page reload: a fresh empty workspace must never look like it just
 * recovered. Module state bridges the Runs → Home remount and a CustomEvent
 * covers an already-mounted Recovery Center.
 */

import { getActiveOrg } from '../auth'

export const RECOVERY_ALL_CLEAR_EVENT = 'janusly:recovery:all-clear'
export const RECOVERY_ALL_CLEAR_WINDOW_MS = 30_000

export type RecoveryAllClearRequest = { downtimeMs?: number }
type ScopedRecoveryAllClearRequest = RecoveryAllClearRequest & { orgId: string }

let pendingRequest: { request: ScopedRecoveryAllClearRequest; expiresAt: number } | null = null

function normalizeRequest(value: unknown): ScopedRecoveryAllClearRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { downtimeMs, orgId } = value as { downtimeMs?: unknown; orgId?: unknown }
  if (typeof orgId !== 'string' || orgId.length === 0) return null
  if (downtimeMs === undefined) return { orgId }
  if (typeof downtimeMs !== 'number' || !Number.isFinite(downtimeMs) || downtimeMs < 0) return null
  return { orgId, downtimeMs }
}

function requestForOrg(
  value: ScopedRecoveryAllClearRequest | null,
  expectedOrgId: string,
): RecoveryAllClearRequest | null {
  if (!value || value.orgId !== expectedOrgId) return null
  return value.downtimeMs === undefined ? {} : { downtimeMs: value.downtimeMs }
}

/** Read and clear the pending success moment. */
export function consumeRecoveryAllClear(expectedOrgId = getActiveOrg()): RecoveryAllClearRequest | null {
  const pending = pendingRequest
  pendingRequest = null
  if (!pending || Date.now() >= pending.expiresAt) return null
  return requestForOrg(pending.request, expectedOrgId)
}

/** Read and validate a live all-clear event. */
export function parseRecoveryAllClearEvent(
  event: Event,
  expectedOrgId = getActiveOrg(),
): RecoveryAllClearRequest | null {
  return event instanceof CustomEvent
    ? requestForOrg(normalizeRequest(event.detail), expectedOrgId)
    : null
}

/** Publish a success moment that can be consumed once during this page session. */
export function requestRecoveryAllClear(request: RecoveryAllClearRequest = {}): void {
  const normalized = normalizeRequest({ ...request, orgId: getActiveOrg() })
  if (!normalized) return
  pendingRequest = {
    request: normalized,
    expiresAt: Date.now() + RECOVERY_ALL_CLEAR_WINDOW_MS,
  }
  window.dispatchEvent(new CustomEvent(RECOVERY_ALL_CLEAR_EVENT, { detail: normalized }))
}
