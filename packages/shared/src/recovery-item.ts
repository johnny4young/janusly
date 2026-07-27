/**
 * Recovery item (incident) contracts — closed enums, SLA defaults, Zod
 * schemas, and per-transition request bodies for the recovery ownership
 * subsystem.
 *
 * One recovery item exists per `(orgId, deadLetterId)` — the row tracks
 * who owns the incident, what severity / SLA it carries, the lifecycle
 * status, and append-only comments. The state machine is enforced at the
 * data layer via CAS-style `UPDATE … WHERE status IN (allowed_pre_states)`
 * (mirrors the conditional-write posture of auto-healing decisions).
 *
 * Pure, zero-I/O — safe to import from web bundle + engine + api + data.
 */

import { z } from 'zod'

// ---------- severities ----------

export const RECOVERY_ITEM_SEVERITIES = ['p1', 'p2', 'p3', 'p4'] as const
export const RecoveryItemSeveritySchema = z.enum(RECOVERY_ITEM_SEVERITIES)
export type RecoveryItemSeverity = z.infer<typeof RecoveryItemSeveritySchema>

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
export const RecoveryItemStatusSchema = z.enum(RECOVERY_ITEM_STATUSES)
export type RecoveryItemStatus = z.infer<typeof RecoveryItemStatusSchema>

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
export const RecoveryItemResolutionReasonSchema = z.enum(RECOVERY_ITEM_RESOLUTION_REASONS)
export type RecoveryItemResolutionReason = z.infer<typeof RecoveryItemResolutionReasonSchema>

// ---------- comments ----------

export const RECOVERY_ITEM_COMMENT_BODY_MAX = 4_000
export const MAX_COMMENTS_PER_ITEM = 200

export const RecoveryItemCommentSchema = z
  .object({
    id: z.string().min(1).max(64),
    authorUserId: z.string().min(1).max(200),
    body: z.string().min(1).max(RECOVERY_ITEM_COMMENT_BODY_MAX),
    createdAt: z.string().min(1).max(64), // ISO timestamp
  })
  .strict()

export type RecoveryItemComment = z.infer<typeof RecoveryItemCommentSchema>

// ---------- request bodies (route → repo) ----------

/** Optional ISO override for the SLA target. Capped at 30 days out. */
const SlaOverrideSchema = z
  .string()
  .datetime()
  .refine((iso) => {
    const ts = new Date(iso).getTime()
    if (Number.isNaN(ts)) return false
    const horizon = Date.now() + 30 * 24 * 60 * 60 * 1_000
    return ts > Date.now() && ts < horizon
  }, 'slaTargetAtOverrideIso must be in the future and within 30 days')
  .optional()

export const AcknowledgeBodySchema = z
  .object({
    owner: z.string().min(1).max(200).optional(),
    severity: RecoveryItemSeveritySchema.optional(),
    slaTargetAtOverrideIso: SlaOverrideSchema,
  })
  .strict()

export const InProgressBodySchema = z
  .object({
    owner: z.string().min(1).max(200).optional(),
  })
  .strict()

export const WaitingExternalBodySchema = z
  .object({
    owner: z.string().min(1).max(200).optional(),
    comment: z.string().min(1).max(RECOVERY_ITEM_COMMENT_BODY_MAX).optional(),
  })
  .strict()

export const EscalateBodySchema = z
  .object({
    severity: RecoveryItemSeveritySchema,
    slaTargetAtOverrideIso: SlaOverrideSchema,
    comment: z.string().min(1).max(RECOVERY_ITEM_COMMENT_BODY_MAX).optional(),
  })
  .strict()

export const ResolveBodySchema = z
  .object({
    resolutionReason: RecoveryItemResolutionReasonSchema,
    comment: z.string().min(1).max(RECOVERY_ITEM_COMMENT_BODY_MAX).optional(),
  })
  .strict()

export const ReopenBodySchema = z
  .object({
    comment: z.string().min(1).max(RECOVERY_ITEM_COMMENT_BODY_MAX).optional(),
  })
  .strict()

export const CommentBodySchema = z
  .object({
    body: z.string().min(1).max(RECOVERY_ITEM_COMMENT_BODY_MAX),
  })
  .strict()

export const AssignOwnerBodySchema = z
  .object({
    owner: z.string().min(1).max(200).nullable().optional(),
  })
  .strict()

// ---------- list filter ----------

export const RECOVERY_ITEMS_DEFAULT_LIMIT = 50
export const RECOVERY_ITEMS_MAX_LIMIT = 200

export const ListRecoveryItemsFilterSchema = z
  .object({
    status: RecoveryItemStatusSchema.optional(),
    owner: z.string().min(1).max(200).optional(),
    severity: RecoveryItemSeveritySchema.optional(),
    limit: z.number().int().min(1).max(RECOVERY_ITEMS_MAX_LIMIT).optional(),
    cursorIso: z.string().datetime().optional(),
  })
  .strict()

export type ListRecoveryItemsFilter = z.infer<typeof ListRecoveryItemsFilterSchema>

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
