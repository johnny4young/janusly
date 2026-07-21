import { describe, expect, it } from 'vitest'

import {
  ALERT_CHANNEL_PARAMS_SCHEMAS,
  ALERT_COOLDOWN_SECONDS_DEFAULT,
  ALERT_COOLDOWN_SECONDS_MAX,
  ALERT_COOLDOWN_SECONDS_MIN,
  ALERT_PARAMS_SCHEMAS,
  ALERT_POLICY_CHANNELS_MAX,
  ALERT_TRIGGERS,
  AlertPolicyConfigSchema,
  validateAlertPolicyConfig,
} from './alert-policy'

const baseChannel = {
  destination: 'slack' as const,
  credentialName: 'Ops Slack',
  params: { channel: '#incidents' },
}

const basePolicy = {
  name: 'DLQ alarm',
  trigger: 'dlq.entry_created' as const,
  parameters: {},
  channels: [baseChannel],
  cooldownSeconds: 600,
  enabled: true,
}

describe('AlertPolicyConfigSchema', () => {
  it('accepts the minimum-viable policy', () => {
    const parsed = AlertPolicyConfigSchema.safeParse(basePolicy)
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown triggers', () => {
    const parsed = AlertPolicyConfigSchema.safeParse({ ...basePolicy, trigger: 'unknown.event' })
    expect(parsed.success).toBe(false)
  })

  it('rejects cooldown below the minimum', () => {
    const parsed = AlertPolicyConfigSchema.safeParse({
      ...basePolicy,
      cooldownSeconds: ALERT_COOLDOWN_SECONDS_MIN - 1,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects cooldown above the maximum', () => {
    const parsed = AlertPolicyConfigSchema.safeParse({
      ...basePolicy,
      cooldownSeconds: ALERT_COOLDOWN_SECONDS_MAX + 1,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects more channels than the cap', () => {
    const parsed = AlertPolicyConfigSchema.safeParse({
      ...basePolicy,
      channels: Array.from({ length: ALERT_POLICY_CHANNELS_MAX + 1 }, () => baseChannel),
    })
    expect(parsed.success).toBe(false)
  })

  it('defaults cooldown / enabled / parameters when absent', () => {
    const parsed = AlertPolicyConfigSchema.parse({
      name: 'minimal',
      trigger: 'dlq.entry_created',
      channels: [baseChannel],
    })
    expect(parsed.cooldownSeconds).toBe(ALERT_COOLDOWN_SECONDS_DEFAULT)
    expect(parsed.enabled).toBe(true)
    expect(parsed.parameters).toEqual({})
  })

  it('rejects unknown top-level keys (strict mode)', () => {
    const parsed = AlertPolicyConfigSchema.safeParse({ ...basePolicy, extraField: 'nope' })
    expect(parsed.success).toBe(false)
  })
})

describe('ALERT_PARAMS_SCHEMAS', () => {
  it('has an entry for every trigger', () => {
    for (const trigger of ALERT_TRIGGERS) {
      expect(ALERT_PARAMS_SCHEMAS[trigger]).toBeDefined()
    }
  })

  it('failure_cluster.threshold requires minFrequency', () => {
    const parsed = ALERT_PARAMS_SCHEMAS['failure_cluster.threshold'].safeParse({})
    expect(parsed.success).toBe(false)
  })

  it('failure_cluster.threshold accepts a minFrequency in range', () => {
    const parsed = ALERT_PARAMS_SCHEMAS['failure_cluster.threshold'].safeParse({ minFrequency: 3 })
    expect(parsed.success).toBe(true)
  })

  it('approval.stalled requires stalledMinutes', () => {
    const parsed = ALERT_PARAMS_SCHEMAS['approval.stalled'].safeParse({})
    expect(parsed.success).toBe(false)
  })

  it('dlq.entry_created accepts empty parameters (no filters)', () => {
    const parsed = ALERT_PARAMS_SCHEMAS['dlq.entry_created'].safeParse({})
    expect(parsed.success).toBe(true)
  })

  it('dlq.entry_created rejects errorSignaturePattern over 200 chars', () => {
    const parsed = ALERT_PARAMS_SCHEMAS['dlq.entry_created'].safeParse({
      errorSignaturePattern: 'x'.repeat(201),
    })
    expect(parsed.success).toBe(false)
  })

  it('workflow.slo_breach metric names limited to known set', () => {
    const good = ALERT_PARAMS_SCHEMAS['workflow.slo_breach'].safeParse({
      metricNames: ['successRate', 'p95'],
    })
    expect(good.success).toBe(true)
    const bad = ALERT_PARAMS_SCHEMAS['workflow.slo_breach'].safeParse({
      metricNames: ['mttr'],
    })
    expect(bad.success).toBe(false)
  })

  it('recovery_item.created accepts an empty filter and severity arrays', () => {
    expect(ALERT_PARAMS_SCHEMAS['recovery_item.created'].safeParse({}).success).toBe(true)
    expect(
      ALERT_PARAMS_SCHEMAS['recovery_item.created'].safeParse({ severities: ['p1', 'p2'] }).success,
    ).toBe(true)
    expect(
      ALERT_PARAMS_SCHEMAS['recovery_item.created'].safeParse({ severities: ['unknown'] }).success,
    ).toBe(false)
  })

  it('workflow.schedule_anomaly accepts an empty filter or a workflowIds allowlist, rejects unknown keys', () => {
    expect(ALERT_PARAMS_SCHEMAS['workflow.schedule_anomaly'].safeParse({}).success).toBe(true)
    expect(
      ALERT_PARAMS_SCHEMAS['workflow.schedule_anomaly'].safeParse({ workflowIds: ['wf_1', 'wf_2'] })
        .success,
    ).toBe(true)
    // v1 exposes no tunable thresholds — an unknown key is rejected by .strict().
    expect(
      ALERT_PARAMS_SCHEMAS['workflow.schedule_anomaly'].safeParse({ thresholdStdDev: 2 }).success,
    ).toBe(false)
  })

  it('credential.expiring requires warnDays in 1..365 and accepts optional kind/name filters', () => {
    expect(ALERT_PARAMS_SCHEMAS['credential.expiring'].safeParse({ warnDays: 14 }).success).toBe(true)
    expect(
      ALERT_PARAMS_SCHEMAS['credential.expiring'].safeParse({
        warnDays: 7,
        credentialKinds: ['github_token'],
        credentialNames: ['prod-token'],
      }).success,
    ).toBe(true)
    // warnDays is required + bounded; an out-of-range or missing value is rejected.
    expect(ALERT_PARAMS_SCHEMAS['credential.expiring'].safeParse({}).success).toBe(false)
    expect(ALERT_PARAMS_SCHEMAS['credential.expiring'].safeParse({ warnDays: 0 }).success).toBe(false)
    expect(ALERT_PARAMS_SCHEMAS['credential.expiring'].safeParse({ warnDays: 366 }).success).toBe(false)
    // .strict() rejects an unknown key.
    expect(
      ALERT_PARAMS_SCHEMAS['credential.expiring'].safeParse({ warnDays: 14, foo: 1 }).success,
    ).toBe(false)
  })

  it('recovery_item.sla_breached accepts a severities filter', () => {
    expect(ALERT_PARAMS_SCHEMAS['recovery_item.sla_breached'].safeParse({}).success).toBe(true)
    expect(
      ALERT_PARAMS_SCHEMAS['recovery_item.sla_breached'].safeParse({ severities: ['p1'] }).success,
    ).toBe(true)
  })
})

describe('ALERT_CHANNEL_PARAMS_SCHEMAS', () => {
  it('slack params accept only a UUID interaction connection id', () => {
    expect(ALERT_CHANNEL_PARAMS_SCHEMAS.slack.safeParse({
      interactionConnectionId: 'f36c0018-ae36-4d96-96c2-c7ed81669e9e',
    }).success).toBe(true)
    expect(ALERT_CHANNEL_PARAMS_SCHEMAS.slack.safeParse({
      interactionConnectionId: 'connection-1',
    }).success).toBe(false)
  })

  it('webhook params require url', () => {
    const parsed = ALERT_CHANNEL_PARAMS_SCHEMAS.webhook.safeParse({})
    expect(parsed.success).toBe(false)
  })

  it('webhook accepts a valid url', () => {
    const parsed = ALERT_CHANNEL_PARAMS_SCHEMAS.webhook.safeParse({
      url: 'https://webhook.site/abc',
    })
    expect(parsed.success).toBe(true)
  })

  it('github params require owner + repo', () => {
    const missing = ALERT_CHANNEL_PARAMS_SCHEMAS.github.safeParse({ owner: 'acme' })
    expect(missing.success).toBe(false)
    const ok = ALERT_CHANNEL_PARAMS_SCHEMAS.github.safeParse({ owner: 'acme', repo: 'ops' })
    expect(ok.success).toBe(true)
  })

  it('email params accept string or array of strings for to', () => {
    expect(ALERT_CHANNEL_PARAMS_SCHEMAS.email.safeParse({ to: 'ops@acme.com' }).success).toBe(true)
    expect(
      ALERT_CHANNEL_PARAMS_SCHEMAS.email.safeParse({ to: ['ops@acme.com', 'sre@acme.com'] }).success,
    ).toBe(true)
    expect(ALERT_CHANNEL_PARAMS_SCHEMAS.email.safeParse({ to: 'not-an-email' }).success).toBe(false)
  })
})

describe('validateAlertPolicyConfig', () => {
  it('returns ok for a fully valid policy', () => {
    const result = validateAlertPolicyConfig({
      ...basePolicy,
      channels: [
        {
          destination: 'webhook',
          credentialName: 'self webhook',
          params: { url: 'https://webhook.site/abc' },
        },
      ],
    })
    expect(result.ok).toBe(true)
  })

  it('flags missing required params per trigger', () => {
    const result = validateAlertPolicyConfig({
      ...basePolicy,
      trigger: 'failure_cluster.threshold',
      parameters: {},
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === 'parameters')).toBe(true)
    }
  })

  it('flags missing required channel params with the channel index', () => {
    const result = validateAlertPolicyConfig({
      ...basePolicy,
      channels: [
        {
          destination: 'webhook',
          credentialName: 'self webhook',
          params: {},
        },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const channelError = result.errors.find((e) => e.field === 'channels')
      expect(channelError?.channelIndex).toBe(0)
    }
  })

  it('flags errors on the right channel index in a multi-channel policy', () => {
    const result = validateAlertPolicyConfig({
      ...basePolicy,
      channels: [
        baseChannel,
        {
          destination: 'github',
          credentialName: 'bot',
          params: { owner: 'acme' },
        },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const channelError = result.errors.find((e) => e.field === 'channels')
      expect(channelError?.channelIndex).toBe(1)
    }
  })
})
