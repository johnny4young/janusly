/**
 * Alert policy contracts — closed-enum trigger taxonomy plus per-trigger
 * parameters and per-destination channel shapes used by the recovery
 * alerting subsystem.
 *
 * Two layers:
 *   - Base shape (`AlertPolicyConfigSchema`) validates `name`, `trigger`,
 *     `channels`, `cooldownSeconds`, `enabled`. `parameters` is left as a
 *     bounded record at this layer.
 *   - Per-trigger refinement (`validateAlertPolicyConfig`) routes
 *     `parameters` to the matching closed shape and returns a typed
 *     discriminator object. This split keeps the schema provider-strict
 *     safe — no `z.discriminatedUnion` on the wire.
 *
 * Channels are per-destination shapes; the matching params schema is
 * required when the destination demands it (e.g., `webhook.url`,
 * `github.owner`+`repo`, `email.to`) and optional otherwise.
 *
 * Pure, zero-I/O — safe to import from web bundle + engine + api + data.
 */

import * as z from 'zod/mini'

const boundedString = (minimum: number, maximum: number) =>
  z.string().check(z.minLength(minimum), z.maxLength(maximum))

const optionalStringList = (itemMaximum: number, listMaximum: number) =>
  z.optional(z.array(boundedString(1, itemMaximum)).check(z.maxLength(listMaximum)))

const boundedInt = (minimum: number, maximum: number) =>
  z.int().check(z.minimum(minimum), z.maximum(maximum))

// ---------- triggers ----------

export const ALERT_TRIGGERS = [
  'dlq.entry_created',
  'failure_cluster.threshold',
  'budget.blocked',
  'limiter.degraded',
  'workflow.slo_breach',
  'approval.stalled',
  'recovery_item.created',
  'recovery_item.sla_breached',
  'workflow.schedule_anomaly',
  'credential.expiring',
  'workflow.circuit_breaker_tripped',
] as const

export const AlertTriggerSchema = /* @__PURE__ */ z.enum(ALERT_TRIGGERS)
export type AlertTrigger = z.infer<typeof AlertTriggerSchema>

// ---------- per-trigger parameters ----------

export const AlertParamsDlqEntryCreatedSchema = /* @__PURE__ */ z.strictObject({
  errorSignaturePattern: z.optional(boundedString(1, 200)),
  workflowIds: optionalStringList(120, 50),
})

export const AlertParamsFailureClusterThresholdSchema = /* @__PURE__ */ z.strictObject({
  minFrequency: boundedInt(2, 1000),
  windowDays: z._default(z.union([z.literal(7), z.literal(14), z.literal(30)]), 7),
})

export const AlertParamsBudgetBlockedSchema = /* @__PURE__ */ z.strictObject({
  scope: z.optional(z.enum(['org', 'workflow'])),
  workflowIds: optionalStringList(120, 50),
})

export const AlertParamsLimiterDegradedSchema = /* @__PURE__ */ z.strictObject({
  buckets: optionalStringList(120, 50),
})

export const AlertParamsWorkflowSloBreachSchema = /* @__PURE__ */ z.strictObject({
  workflowIds: optionalStringList(120, 50),
  metricNames: z.optional(
    z.array(z.enum(['successRate', 'p95'])).check(z.maxLength(2)),
  ),
})

export const AlertParamsApprovalStalledSchema = /* @__PURE__ */ z.strictObject({
  stalledMinutes: boundedInt(5, 43200),
  workflowIds: optionalStringList(120, 50),
})

export const AlertParamsRecoveryItemCreatedSchema = /* @__PURE__ */ z.strictObject({
  severities: z.optional(z.array(z.enum(['p1', 'p2', 'p3', 'p4'])).check(z.maxLength(4))),
  workflowIds: optionalStringList(120, 50),
})

export const AlertParamsRecoveryItemSlaBreachedSchema = /* @__PURE__ */ z.strictObject({
  severities: z.optional(z.array(z.enum(['p1', 'p2', 'p3', 'p4'])).check(z.maxLength(4))),
  workflowIds: optionalStringList(120, 50),
})

export const AlertParamsWorkflowScheduleAnomalySchema = /* @__PURE__ */ z.strictObject({
    // Optional allowlist of workflow ids to alert on. Empty/absent → every
    // actively-scheduled workflow. The anomaly thresholds + 90-day window are
    // fixed in the engine (not tunable per policy in v1).
    workflowIds: optionalStringList(120, 50),
  })

export const AlertParamsCredentialExpiringSchema = /* @__PURE__ */ z.strictObject({
    // Fire when a credential expires within this many days. 1..365.
    warnDays: boundedInt(1, 365),
    // Optional allowlists. `credentialKinds` is a free string array (the
    // credentials table intentionally keeps `kind` open — a new integration
    // shouldn't need an alert-schema edit). Empty/absent → all kinds / names.
    credentialKinds: optionalStringList(120, 10),
    credentialNames: optionalStringList(120, 50),
  })

export const AlertParamsWorkflowCircuitBreakerTrippedSchema = /* @__PURE__ */ z.strictObject({
    // Optional allowlist — absent/empty means every workflow in the org.
    workflowIds: optionalStringList(120, 50),
  })

/**
 * Per-trigger parameters dispatch table. Caller picks the schema by the
 * value of `policy.trigger` then runs `.safeParse(policy.parameters)`.
 */
export const ALERT_PARAMS_SCHEMAS = {
  'dlq.entry_created': AlertParamsDlqEntryCreatedSchema,
  'failure_cluster.threshold': AlertParamsFailureClusterThresholdSchema,
  'budget.blocked': AlertParamsBudgetBlockedSchema,
  'limiter.degraded': AlertParamsLimiterDegradedSchema,
  'workflow.slo_breach': AlertParamsWorkflowSloBreachSchema,
  'approval.stalled': AlertParamsApprovalStalledSchema,
  'recovery_item.created': AlertParamsRecoveryItemCreatedSchema,
  'recovery_item.sla_breached': AlertParamsRecoveryItemSlaBreachedSchema,
  'workflow.schedule_anomaly': AlertParamsWorkflowScheduleAnomalySchema,
  'credential.expiring': AlertParamsCredentialExpiringSchema,
  'workflow.circuit_breaker_tripped': AlertParamsWorkflowCircuitBreakerTrippedSchema,
} as const satisfies Record<AlertTrigger, z.ZodMiniType>

// ---------- channels ----------

export const ALERT_DESTINATIONS = ['slack', 'webhook', 'email', 'github'] as const
export const AlertDestinationSchema = /* @__PURE__ */ z.enum(ALERT_DESTINATIONS)
export type AlertDestination = z.infer<typeof AlertDestinationSchema>

export const AlertChannelSlackParamsSchema = /* @__PURE__ */ z.strictObject({
  channel: z.optional(boundedString(1, 120)),
  threadTs: z.optional(boundedString(1, 64)),
  interactionConnectionId: z.optional(z.uuid()),
})

export const AlertChannelWebhookParamsSchema = /* @__PURE__ */ z.strictObject({
  url: z.url().check(z.maxLength(2048)),
})

const AlertEmailSchema = /* @__PURE__ */ z.email().check(z.maxLength(254))

export const AlertChannelEmailParamsSchema = /* @__PURE__ */ z.strictObject({
  to: z.union([
    AlertEmailSchema,
    z.array(AlertEmailSchema).check(z.minLength(1), z.maxLength(20)),
  ]),
  subject: z.optional(boundedString(1, 200)),
})

export const AlertChannelGithubParamsSchema = /* @__PURE__ */ z.strictObject({
  owner: boundedString(1, 120),
  repo: boundedString(1, 120),
  labels: optionalStringList(60, 10),
  assignees: optionalStringList(60, 10),
})

export const ALERT_CHANNEL_PARAMS_SCHEMAS = {
  slack: AlertChannelSlackParamsSchema,
  webhook: AlertChannelWebhookParamsSchema,
  email: AlertChannelEmailParamsSchema,
  github: AlertChannelGithubParamsSchema,
} as const satisfies Record<AlertDestination, z.ZodMiniType>

/**
 * Base channel shape — leaves `params` as a bounded record so the wire shape
 * stays provider-strict friendly. Use `validateAlertChannel` to refine
 * `params` per destination after the base parse.
 */
export const AlertChannelSchema = /* @__PURE__ */ z.strictObject({
    destination: AlertDestinationSchema,
    credentialName: boundedString(1, 200),
    params: z.optional(z.record(z.string(), z.unknown())),
  })

// ---------- policy base ----------

/**
 * Per-policy cooldown bounds. Lower bound prevents alert storms; upper bound
 * keeps cooldowns from outliving an operator's mental model (24h max).
 */
export const ALERT_COOLDOWN_SECONDS_MIN = 60
export const ALERT_COOLDOWN_SECONDS_MAX = 86_400
export const ALERT_COOLDOWN_SECONDS_DEFAULT = 900

export const ALERT_POLICY_NAME_MAX = 120
export const ALERT_POLICY_CHANNELS_MIN = 1
export const ALERT_POLICY_CHANNELS_MAX = 5

export const AlertPolicyConfigSchema = /* @__PURE__ */ z.strictObject({
    name: boundedString(1, ALERT_POLICY_NAME_MAX),
    trigger: AlertTriggerSchema,
    parameters: z._default(z.record(z.string(), z.unknown()), {}),
    channels: z
      .array(AlertChannelSchema)
      .check(z.minLength(ALERT_POLICY_CHANNELS_MIN), z.maxLength(ALERT_POLICY_CHANNELS_MAX)),
    cooldownSeconds: z._default(
      boundedInt(ALERT_COOLDOWN_SECONDS_MIN, ALERT_COOLDOWN_SECONDS_MAX),
      ALERT_COOLDOWN_SECONDS_DEFAULT,
    ),
    enabled: z._default(z.boolean(), true),
  })

export type AlertPolicyConfig = z.infer<typeof AlertPolicyConfigSchema>

// ---------- refinement (per-trigger + per-channel params) ----------

export type AlertPolicyValidationError = {
  field: 'parameters' | 'channels'
  channelIndex?: number
  message: string
}

export type AlertPolicyValidationResult =
  | { ok: true; policy: AlertPolicyConfig }
  | { ok: false; errors: AlertPolicyValidationError[] }

/**
 * Validate an already-base-parsed policy against the per-trigger parameters
 * schema and the per-destination channel params schemas. Returns either a
 * fully typed policy or a list of structured errors (so the API can return
 * a 422 with stable error codes and the web can surface inline messages).
 */
export function validateAlertPolicyConfig(policy: AlertPolicyConfig): AlertPolicyValidationResult {
  const errors: AlertPolicyValidationError[] = []

  const paramsSchema = ALERT_PARAMS_SCHEMAS[policy.trigger]
  const parsedParams = paramsSchema.safeParse(policy.parameters)
  if (!parsedParams.success) {
    errors.push({
      field: 'parameters',
      message: parsedParams.error.issues
        .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
        .join('; '),
    })
  }

  policy.channels.forEach((channel, idx) => {
    const channelSchema = ALERT_CHANNEL_PARAMS_SCHEMAS[channel.destination]
    const parsed = channelSchema.safeParse(channel.params ?? {})
    if (!parsed.success) {
      errors.push({
        field: 'channels',
        channelIndex: idx,
        message: parsed.error.issues
          .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
          .join('; '),
      })
    }
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, policy }
}

// ---------- dispatch outcomes ----------

export const AlertChannelResultSchema = /* @__PURE__ */ z.strictObject({
    destination: AlertDestinationSchema,
    credentialName: boundedString(1, 200),
    ok: z.boolean(),
    statusCode: z.optional(z.nullable(boundedInt(100, 599))),
    error: z.optional(z.nullable(z.string().check(z.maxLength(1000)))),
    latencyMs: z.int().check(z.minimum(0)),
  })

