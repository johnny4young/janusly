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

import * as z from 'zod/mini'

import {
  RECOVERY_ITEM_SEVERITIES,
  RECOVERY_ITEM_STATUSES,
  RECOVERY_ITEM_RESOLUTION_REASONS,
  RECOVERY_ITEM_COMMENT_BODY_MAX,
} from './recovery-item-values'
export * from './recovery-item-values'

export const RecoveryItemSeveritySchema = /* @__PURE__ */ z.enum(RECOVERY_ITEM_SEVERITIES)
export type RecoveryItemSeverity = z.infer<typeof RecoveryItemSeveritySchema>
export const RecoveryItemStatusSchema = /* @__PURE__ */ z.enum(RECOVERY_ITEM_STATUSES)
export type RecoveryItemStatus = z.infer<typeof RecoveryItemStatusSchema>
export const RecoveryItemResolutionReasonSchema = /* @__PURE__ */ z.enum(RECOVERY_ITEM_RESOLUTION_REASONS)
export type RecoveryItemResolutionReason = z.infer<typeof RecoveryItemResolutionReasonSchema>

// ---------- request bodies (route → repo) ----------

/** Optional ISO override for the SLA target. Capped at 30 days out. */
const SlaOverrideSchema = /* @__PURE__ */ z.optional(
  z.iso.datetime().check(z.refine((iso) => {
    const ts = new Date(iso).getTime()
    if (Number.isNaN(ts)) return false
    const horizon = Date.now() + 30 * 24 * 60 * 60 * 1_000
    return ts > Date.now() && ts < horizon
  }, 'slaTargetAtOverrideIso must be in the future and within 30 days')),
)

export const AcknowledgeBodySchema = /* @__PURE__ */ z.strictObject({
    owner: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
    severity: z.optional(RecoveryItemSeveritySchema),
    slaTargetAtOverrideIso: SlaOverrideSchema,
  })

export const EscalateBodySchema = /* @__PURE__ */ z.strictObject({
    severity: RecoveryItemSeveritySchema,
    slaTargetAtOverrideIso: SlaOverrideSchema,
    comment: z.optional(
      z.string().check(z.minLength(1), z.maxLength(RECOVERY_ITEM_COMMENT_BODY_MAX)),
    ),
  })

export const ResolveBodySchema = /* @__PURE__ */ z.strictObject({
    resolutionReason: RecoveryItemResolutionReasonSchema,
    comment: z.optional(
      z.string().check(z.minLength(1), z.maxLength(RECOVERY_ITEM_COMMENT_BODY_MAX)),
    ),
  })

export const ReopenBodySchema = /* @__PURE__ */ z.strictObject({
  comment: z.optional(
    z.string().check(z.minLength(1), z.maxLength(RECOVERY_ITEM_COMMENT_BODY_MAX)),
  ),
})

export const CommentBodySchema = /* @__PURE__ */ z.strictObject({
  body: z.string().check(z.minLength(1), z.maxLength(RECOVERY_ITEM_COMMENT_BODY_MAX)),
})

export const AssignOwnerBodySchema = /* @__PURE__ */ z.strictObject({
  owner: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(200)))),
})
