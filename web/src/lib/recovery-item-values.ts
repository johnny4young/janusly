/** Recovery UI values and pure helpers, independent of write-body validation. */

import type { RecoveryItemSeverity, RecoveryItemStatus } from './recovery-item'
export type { RecoveryItemSeverity, RecoveryItemStatus, RecoveryItemResolutionReason } from './recovery-item'

// ---------- severities ----------

export const RECOVERY_ITEM_SEVERITIES = ['p1', 'p2', 'p3', 'p4'] as const

/**
 * SLA defaults per severity, in seconds. Operator can override at
 * acknowledge/escalate time via `slaTargetAtOverrideIso`. Tuned for the
 * typical SaaS operator on-call rhythm: p1 hour-class, p4 week-class.
 */
export const SLA_SECONDS_BY_SEVERITY: Record<RecoveryItemSeverity, number> = {
  p1: 60 * 60, //  1h
  p2: 4 * 60 * 60, //  4h
  p3: 24 * 60 * 60, //  1d
  p4: 7 * 24 * 60 * 60, //  7d
} as const

// ---------- lifecycle status ----------

export const RECOVERY_ITEM_STATUSES = [
  'open',
  'acknowledged',
  'in_progress',
  'waiting_external',
  'resolved',
  'reopened',
] as const

/**
 * Allowed pre-states per transition. Used by the data layer to build the
 * CAS predicate — concurrent operator clicks can't double-apply because
 * the loser sees `status NOT IN (allowed_pre_states)` and returns 409.
 */
export const ALLOWED_PRE_STATES: Record<string, readonly RecoveryItemStatus[]> = {
  acknowledge: ['open', 'reopened'],
  in_progress: ['acknowledged', 'waiting_external'],
  waiting_external: ['acknowledged', 'in_progress'],
  resolve: ['open', 'acknowledged', 'in_progress', 'waiting_external', 'reopened'],
  reopen: ['resolved'],
} as const

// ---------- resolution reasons ----------

export const RECOVERY_ITEM_RESOLUTION_REASONS = [
  'fixed_by_patch',
  'rolled_back',
  'upstream_fixed',
  'accepted_loss',
  'not_a_bug',
  /** Set only after a generation-matched replay reaches terminal node success. */
  'sandbox_replay_succeeded',
] as const

// ---------- comments ----------

export const RECOVERY_ITEM_COMMENT_BODY_MAX = 4_000
export const MAX_COMMENTS_PER_ITEM = 200

// ---------- helpers ----------

/**
 * Compute the default SLA target given a severity and a start time.
 *
 * `secondsBySeverity` lets a caller pass org-configured targets (in seconds)
 * instead of the built-in `SLA_SECONDS_BY_SEVERITY` defaults — the data layer
 * resolves the tenant's `recovery.slaPolicies` config and passes the merged
 * map here, keeping this function pure/zero-I/O. A partial map still works:
 * any severity the map omits falls back to the built-in default via `??`.
 */
export function defaultSlaTargetAt(
  severity: RecoveryItemSeverity,
  from: Date = new Date(),
  secondsBySeverity: Partial<Record<RecoveryItemSeverity, number>> = SLA_SECONDS_BY_SEVERITY,
): Date {
  const seconds = secondsBySeverity[severity] ?? SLA_SECONDS_BY_SEVERITY[severity]
  return new Date(from.getTime() + seconds * 1_000)
}

/** Severity ordering: p1 (highest) -> p4 (lowest). */
const SEVERITY_RANK: Record<RecoveryItemSeverity, number> = { p1: 4, p2: 3, p3: 2, p4: 1 }

/** Returns true when `to` is a higher-severity bump from `from`. */
export function isSeverityEscalation(from: RecoveryItemSeverity, to: RecoveryItemSeverity): boolean {
  return SEVERITY_RANK[to] > SEVERITY_RANK[from]
}
