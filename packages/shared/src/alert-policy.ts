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

import { z } from 'zod'

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
] as const

export const AlertTriggerSchema = z.enum(ALERT_TRIGGERS)
export type AlertTrigger = z.infer<typeof AlertTriggerSchema>

// ---------- per-trigger parameters ----------

export const AlertParamsDlqEntryCreatedSchema = z
  .object({
    errorSignaturePattern: z.string().min(1).max(200).optional(),
    workflowIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

export const AlertParamsFailureClusterThresholdSchema = z
  .object({
    minFrequency: z.number().int().min(2).max(1000),
    windowDays: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(7),
  })
  .strict()

export const AlertParamsBudgetBlockedSchema = z
  .object({
    scope: z.enum(['org', 'workflow']).optional(),
    workflowIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

export const AlertParamsLimiterDegradedSchema = z
  .object({
    buckets: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

export const AlertParamsWorkflowSloBreachSchema = z
  .object({
    workflowIds: z.array(z.string().min(1).max(120)).max(50).optional(),
    metricNames: z.array(z.enum(['successRate', 'p95'])).max(2).optional(),
  })
  .strict()

export const AlertParamsApprovalStalledSchema = z
  .object({
    stalledMinutes: z.number().int().min(5).max(43200),
    workflowIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

export const AlertParamsRecoveryItemCreatedSchema = z
  .object({
    severities: z.array(z.enum(['p1', 'p2', 'p3', 'p4'])).max(4).optional(),
    workflowIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

export const AlertParamsRecoveryItemSlaBreachedSchema = z
  .object({
    severities: z.array(z.enum(['p1', 'p2', 'p3', 'p4'])).max(4).optional(),
    workflowIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

export const AlertParamsWorkflowScheduleAnomalySchema = z
  .object({
    // Optional allowlist of workflow ids to alert on. Empty/absent → every
    // actively-scheduled workflow. The anomaly thresholds + 90-day window are
    // fixed in the engine (not tunable per policy in v1).
    workflowIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

export const AlertParamsCredentialExpiringSchema = z
  .object({
    // Fire when a credential expires within this many days. 1..365.
    warnDays: z.number().int().min(1).max(365),
    // Optional allowlists. `credentialKinds` is a free string array (the
    // credentials table intentionally keeps `kind` open — a new integration
    // shouldn't need an alert-schema edit). Empty/absent → all kinds / names.
    credentialKinds: z.array(z.string().min(1).max(120)).max(10).optional(),
    credentialNames: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict()

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
} as const satisfies Record<AlertTrigger, z.ZodTypeAny>

export type AlertParamsByTrigger = {
  'dlq.entry_created': z.infer<typeof AlertParamsDlqEntryCreatedSchema>
  'failure_cluster.threshold': z.infer<typeof AlertParamsFailureClusterThresholdSchema>
  'budget.blocked': z.infer<typeof AlertParamsBudgetBlockedSchema>
  'limiter.degraded': z.infer<typeof AlertParamsLimiterDegradedSchema>
  'workflow.slo_breach': z.infer<typeof AlertParamsWorkflowSloBreachSchema>
  'approval.stalled': z.infer<typeof AlertParamsApprovalStalledSchema>
  'recovery_item.created': z.infer<typeof AlertParamsRecoveryItemCreatedSchema>
  'recovery_item.sla_breached': z.infer<typeof AlertParamsRecoveryItemSlaBreachedSchema>
  'workflow.schedule_anomaly': z.infer<typeof AlertParamsWorkflowScheduleAnomalySchema>
  'credential.expiring': z.infer<typeof AlertParamsCredentialExpiringSchema>
}

// ---------- channels ----------

export const ALERT_DESTINATIONS = ['slack', 'webhook', 'email', 'github'] as const
export const AlertDestinationSchema = z.enum(ALERT_DESTINATIONS)
export type AlertDestination = z.infer<typeof AlertDestinationSchema>

export const AlertChannelSlackParamsSchema = z
  .object({
    channel: z.string().min(1).max(120).optional(),
    threadTs: z.string().min(1).max(64).optional(),
  })
  .strict()

export const AlertChannelWebhookParamsSchema = z
  .object({
    url: z.string().url().max(2048),
  })
  .strict()

export const AlertChannelEmailParamsSchema = z
  .object({
    to: z.union([z.string().email().max(254), z.array(z.string().email().max(254)).min(1).max(20)]),
    subject: z.string().min(1).max(200).optional(),
  })
  .strict()

export const AlertChannelGithubParamsSchema = z
  .object({
    owner: z.string().min(1).max(120),
    repo: z.string().min(1).max(120),
    labels: z.array(z.string().min(1).max(60)).max(10).optional(),
    assignees: z.array(z.string().min(1).max(60)).max(10).optional(),
  })
  .strict()

export const ALERT_CHANNEL_PARAMS_SCHEMAS = {
  slack: AlertChannelSlackParamsSchema,
  webhook: AlertChannelWebhookParamsSchema,
  email: AlertChannelEmailParamsSchema,
  github: AlertChannelGithubParamsSchema,
} as const satisfies Record<AlertDestination, z.ZodTypeAny>

export type AlertChannelParamsByDestination = {
  slack: z.infer<typeof AlertChannelSlackParamsSchema>
  webhook: z.infer<typeof AlertChannelWebhookParamsSchema>
  email: z.infer<typeof AlertChannelEmailParamsSchema>
  github: z.infer<typeof AlertChannelGithubParamsSchema>
}

/**
 * Base channel shape — leaves `params` as a bounded record so the wire shape
 * stays provider-strict friendly. Use `validateAlertChannel` to refine
 * `params` per destination after the base parse.
 */
export const AlertChannelSchema = z
  .object({
    destination: AlertDestinationSchema,
    credentialName: z.string().min(1).max(200),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type AlertChannel = z.infer<typeof AlertChannelSchema>

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

export const AlertPolicyConfigSchema = z
  .object({
    name: z.string().min(1).max(ALERT_POLICY_NAME_MAX),
    trigger: AlertTriggerSchema,
    parameters: z.record(z.string(), z.unknown()).default({}),
    channels: z
      .array(AlertChannelSchema)
      .min(ALERT_POLICY_CHANNELS_MIN)
      .max(ALERT_POLICY_CHANNELS_MAX),
    cooldownSeconds: z
      .number()
      .int()
      .min(ALERT_COOLDOWN_SECONDS_MIN)
      .max(ALERT_COOLDOWN_SECONDS_MAX)
      .default(ALERT_COOLDOWN_SECONDS_DEFAULT),
    enabled: z.boolean().default(true),
  })
  .strict()

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

export const ALERT_OUTCOMES = ['delivered', 'delivery_failed'] as const
export const AlertOutcomeSchema = z.enum(ALERT_OUTCOMES)
export type AlertOutcome = z.infer<typeof AlertOutcomeSchema>

export const AlertChannelResultSchema = z
  .object({
    destination: AlertDestinationSchema,
    credentialName: z.string().min(1).max(200),
    ok: z.boolean(),
    statusCode: z.number().int().min(100).max(599).nullable().optional(),
    error: z.string().max(1000).nullable().optional(),
    latencyMs: z.number().int().min(0),
  })
  .strict()

export type AlertChannelResult = z.infer<typeof AlertChannelResultSchema>
