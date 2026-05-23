import { describe, expect, it } from 'vitest'

import {
  AcknowledgeBodySchema,
  ALLOWED_PRE_STATES,
  AssignOwnerBodySchema,
  CommentBodySchema,
  EscalateBodySchema,
  MAX_COMMENTS_PER_ITEM,
  RECOVERY_ITEM_COMMENT_BODY_MAX,
  RECOVERY_ITEM_RESOLUTION_REASONS,
  RECOVERY_ITEM_SEVERITIES,
  RECOVERY_ITEM_STATUSES,
  ResolveBodySchema,
  ReopenBodySchema,
  SLA_SECONDS_BY_SEVERITY,
  defaultSlaTargetAt,
  isSeverityEscalation,
} from './recovery-item'

describe('recovery-item closed enums', () => {
  it('has exactly the 4 severities p1..p4', () => {
    expect(RECOVERY_ITEM_SEVERITIES).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('has exactly the 6 statuses', () => {
    expect(RECOVERY_ITEM_STATUSES).toEqual([
      'open',
      'acknowledged',
      'in_progress',
      'waiting_external',
      'resolved',
      'reopened',
    ])
  })

  it('has the 6 resolution reasons including the auto-close sentinel', () => {
    expect(RECOVERY_ITEM_RESOLUTION_REASONS).toContain('sandbox_replay_succeeded')
    expect(RECOVERY_ITEM_RESOLUTION_REASONS).toContain('fixed_by_patch')
  })
})

describe('SLA defaults', () => {
  it('p1 < p2 < p3 < p4 in seconds (more severe → shorter SLA)', () => {
    expect(SLA_SECONDS_BY_SEVERITY.p1).toBeLessThan(SLA_SECONDS_BY_SEVERITY.p2)
    expect(SLA_SECONDS_BY_SEVERITY.p2).toBeLessThan(SLA_SECONDS_BY_SEVERITY.p3)
    expect(SLA_SECONDS_BY_SEVERITY.p3).toBeLessThan(SLA_SECONDS_BY_SEVERITY.p4)
  })

  it('p1 is exactly 1 hour', () => {
    expect(SLA_SECONDS_BY_SEVERITY.p1).toBe(3_600)
  })

  it('defaultSlaTargetAt advances by the right amount', () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const target = defaultSlaTargetAt('p2', from)
    expect(target.toISOString()).toBe('2026-01-01T04:00:00.000Z')
  })
})

describe('isSeverityEscalation', () => {
  it('treats p3 → p1 as escalation', () => {
    expect(isSeverityEscalation('p3', 'p1')).toBe(true)
  })
  it('treats p1 → p3 as de-escalation', () => {
    expect(isSeverityEscalation('p1', 'p3')).toBe(false)
  })
  it('same severity is not escalation', () => {
    expect(isSeverityEscalation('p2', 'p2')).toBe(false)
  })
})

describe('ALLOWED_PRE_STATES', () => {
  it('acknowledge accepts open + reopened, rejects others', () => {
    expect(ALLOWED_PRE_STATES.acknowledge).toContain('open')
    expect(ALLOWED_PRE_STATES.acknowledge).toContain('reopened')
    expect(ALLOWED_PRE_STATES.acknowledge).not.toContain('resolved')
    expect(ALLOWED_PRE_STATES.acknowledge).not.toContain('acknowledged')
  })

  it('reopen only accepts resolved', () => {
    expect(ALLOWED_PRE_STATES.reopen).toEqual(['resolved'])
  })

  it('resolve accepts every non-terminal state', () => {
    expect(ALLOWED_PRE_STATES.resolve).toEqual([
      'open',
      'acknowledged',
      'in_progress',
      'waiting_external',
      'reopened',
    ])
  })
})

describe('body schemas', () => {
  it('AcknowledgeBodySchema accepts empty body (operator just acknowledges)', () => {
    expect(AcknowledgeBodySchema.safeParse({}).success).toBe(true)
  })

  it('AcknowledgeBodySchema rejects unknown keys (strict)', () => {
    expect(AcknowledgeBodySchema.safeParse({ wrongKey: 'x' }).success).toBe(false)
  })

  it('AcknowledgeBodySchema rejects SLA override more than 30 days out', () => {
    const tooFar = new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000).toISOString()
    const result = AcknowledgeBodySchema.safeParse({ slaTargetAtOverrideIso: tooFar })
    expect(result.success).toBe(false)
  })

  it('AcknowledgeBodySchema rejects SLA override in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const result = AcknowledgeBodySchema.safeParse({ slaTargetAtOverrideIso: past })
    expect(result.success).toBe(false)
  })

  it('EscalateBodySchema requires severity', () => {
    expect(EscalateBodySchema.safeParse({}).success).toBe(false)
    expect(EscalateBodySchema.safeParse({ severity: 'p1' }).success).toBe(true)
  })

  it('ResolveBodySchema requires a resolutionReason from the closed enum', () => {
    expect(ResolveBodySchema.safeParse({}).success).toBe(false)
    expect(ResolveBodySchema.safeParse({ resolutionReason: 'unknown' }).success).toBe(false)
    expect(ResolveBodySchema.safeParse({ resolutionReason: 'fixed_by_patch' }).success).toBe(true)
  })

  it('ReopenBodySchema accepts empty body and optional comment', () => {
    expect(ReopenBodySchema.safeParse({}).success).toBe(true)
    expect(ReopenBodySchema.safeParse({ comment: 'reverted' }).success).toBe(true)
  })

  it('AssignOwnerBodySchema accepts an omitted owner for workflow metadata defaulting', () => {
    expect(AssignOwnerBodySchema.safeParse({}).success).toBe(true)
    expect(AssignOwnerBodySchema.safeParse({ owner: null }).success).toBe(true)
  })

  it('CommentBodySchema enforces body length cap', () => {
    expect(CommentBodySchema.safeParse({ body: '' }).success).toBe(false)
    expect(
      CommentBodySchema.safeParse({ body: 'a'.repeat(RECOVERY_ITEM_COMMENT_BODY_MAX + 1) }).success,
    ).toBe(false)
    expect(CommentBodySchema.safeParse({ body: 'Triage in progress' }).success).toBe(true)
  })
})

describe('MAX_COMMENTS_PER_ITEM', () => {
  it('is a sane cap (200)', () => {
    expect(MAX_COMMENTS_PER_ITEM).toBe(200)
  })
})
