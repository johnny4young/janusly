/**
 * Authoritative all-clear coordinator for every recovery-queue mutation.
 *
 * A successful replay or resolve is not enough to announce an empty queue:
 * another open failure may live outside the current keyset page. This helper
 * checks the org-wide count and only then publishes the transient, org-scoped
 * success handoff consumed by the Recovery Center.
 */

import { api } from '../api'
import {
  requestRecoveryAllClear,
  type RecoveryAllClearRequest,
} from './recovery-all-clear-bus'

/** Publish the success handoff only when the authoritative open count is zero. */
export async function requestRecoveryAllClearIfQueueEmpty(
  request: RecoveryAllClearRequest = {},
): Promise<boolean> {
  try {
    const payload = await api('/dlq/counts') as { open?: unknown } | null
    const open = payload?.open
    if (typeof open !== 'number' || !Number.isInteger(open) || open !== 0) return false
    requestRecoveryAllClear(request)
    return true
  } catch {
    // Recovery succeeded; unavailable observability must only suppress the
    // celebration, never turn the mutation into a user-visible failure.
    return false
  }
}
