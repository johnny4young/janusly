/** UI metadata shared with the unchanged request validators. */

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

export type AlertTrigger = (typeof ALERT_TRIGGERS)[number]

export const ALERT_DESTINATIONS = ['slack', 'webhook', 'email', 'github'] as const

export type AlertDestination = (typeof ALERT_DESTINATIONS)[number]

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
