/**
 * Tests for the server-event translation helpers. They look up
 * `<surface>.<code>` in the catalog and fall back to `serverEvents.fallback`
 * when no key exists, so the user always sees something readable.
 */

import { describe, beforeAll, beforeEach, expect, it } from 'vitest'
import { WORKFLOW_EVENT_TYPES } from '@janusly/shared/src/run-events'
import en from './locales/en/common.json'
import es from './locales/es/common.json'
import { initI18n } from './init'
import { tValidationIssue, tReadinessIssue, tAiReviewIssue, tRunEvent, tFailureCluster, tHealthRationale, tRecoveryMetricRationale, tApiError, tServerFallback } from './server-events'

beforeAll(() => {
  initI18n('en')
})

beforeEach(() => {
  initI18n('en')
})

describe('tValidationIssue', () => {
  it('translates a known code', () => {
    const result = tValidationIssue({ code: 'workflow_missing_outputs', message: 'fallback message' })
    expect(result).toBe("Workflow doesn't declare any outputs")
  })

  it('falls back to the original message for an unknown code', () => {
    const result = tValidationIssue({ code: 'this_code_does_not_exist', message: 'something broke' })
    expect(result).toBe('something broke')
  })
})

describe('tReadinessIssue', () => {
  it('translates a known readiness code', () => {
    const result = tReadinessIssue({ code: 'sensitive_action_missing_approval', severity: 'fail', message: 'fb' })
    expect(result).toBe('Write-side step has no approval upstream')
  })
})

describe('tAiReviewIssue', () => {
  it('falls back to the message when no specific code is mapped', () => {
    const result = tAiReviewIssue({ code: 'made_up_code', severity: 'warn', message: 'reviewer says X' })
    expect(result).toBe('reviewer says X')
  })
})

describe('tRunEvent', () => {
  it('translates a known event type with payload interpolation', () => {
    const result = tRunEvent({ id: 'evt1', type: 'node.failed', nodeId: 'http_call' })
    expect(result).toBe('Step http_call failed')
  })

  it('falls back to a debug-friendly description for unknown types', () => {
    const result = tRunEvent({ id: 'evt2', type: 'totally.new.event', nodeId: 'foo' })
    expect(result).toContain('totally.new.event')
  })
})

describe('runEvents catalog coverage', () => {
  // Contract: every lifecycle event type the engine can write to run_events
  // (the closed WORKFLOW_EVENT_TYPES catalogue in @janusly/shared) must have a
  // `runEvents.<type>` label in EVERY locale — otherwise it renders as a raw
  // type string on the run timeline. Adding an engine event type without its
  // label fails here.
  const catalogs = { en: en as Record<string, string>, es: es as Record<string, string> }

  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has a label for every WORKFLOW_EVENT_TYPES member`, () => {
      const missing = WORKFLOW_EVENT_TYPES.filter(type => !(`runEvents.${type}` in catalog))
      expect(missing, `${locale} missing runEvents labels for: ${missing.join(', ')}`).toEqual([])
    })
  }

  it('tRunEvent never falls back for a catalogued lifecycle type', () => {
    for (const type of WORKFLOW_EVENT_TYPES) {
      const rendered = tRunEvent({ id: `evt-${type}`, type, nodeId: 'demo_node' })
      // The fallback path echoes the raw type string; a real label won't.
      expect(rendered, `${type} rendered as raw fallback`).not.toBe(`${type} (demo_node)`)
      expect(rendered, `${type} rendered as bare type`).not.toBe(type)
    }
  })
})

describe('tFailureCluster', () => {
  it('translates a known signature with metadata', () => {
    const result = tFailureCluster({
      signatureCode: 'http_error',
      signatureLabel: 'HTTP 500 on http step',
      signatureMeta: { status: 500, nodeType: 'http' },
    })
    expect(result).toBe('HTTP 500 on http step')
  })

  it('falls back to the signatureLabel for unknown codes', () => {
    const result = tFailureCluster({ signatureCode: 'brand_new_kind', signatureLabel: 'Some new failure' })
    expect(result).toBe('Some new failure')
  })
})

describe('tHealthRationale', () => {
  it('translates health rationale codes and metadata', () => {
    initI18n('es')

    const result = tHealthRationale({
      rationale: 'fallback',
      rationaleCode: 'reliability.summary',
      rationaleMeta: { successCount: 8, totalRuns: 10, dlqOpenCount: 1, retryCount: 3 },
    })

    expect(result).toBe('8/10 ejecuciones terminaron bien; 1 dead letters abiertas; 3 eventos de reintento.')
  })

  it('falls back to the server rationale when a health code is unknown', () => {
    const result = tHealthRationale({ rationale: 'server text', rationaleCode: 'new.health.code' })
    expect(result).toBe('server text')
  })
})

describe('tRecoveryMetricRationale', () => {
  it('translates recovery metric rationale codes', () => {
    initI18n('es')

    const result = tRecoveryMetricRationale({
      rationale: 'fallback',
      rationaleCode: 'replay.summary',
      rationaleMeta: { replayedSuccess: 4, replayedAndReopened: 2 },
    })

    expect(result).toBe('4 repeticiones terminaron bien · 2 volvieron a fallar.')
  })
})

describe('tServerFallback', () => {
  it('returns the message verbatim today', () => {
    expect(tServerFallback('hello world')).toBe('hello world')
  })

  it('returns an empty string for empty input', () => {
    expect(tServerFallback(null)).toBe('')
    expect(tServerFallback(undefined)).toBe('')
    expect(tServerFallback('')).toBe('')
  })
})

describe('tApiError', () => {
  it('translates a known code with params interpolation (ES)', () => {
    initI18n('es')
    const result = tApiError({
      code: 'member_exists',
      error: 'Member already exists for this org',
      params: { email: 'ada@example.com' },
    })
    expect(result).toContain('ada@example.com')
    // Must be Spanish, not the EN fallback.
    expect(result).not.toBe('Member already exists for this org')
  })

  it('falls back to the literal `error` string when the code is unknown', () => {
    const result = tApiError({
      code: 'this_code_was_never_catalogued',
      error: 'A specific server message',
    })
    expect(result).toBe('A specific server message')
  })

  it('falls back to the literal `error` when no code is supplied', () => {
    const result = tApiError({ error: 'free-form server message' })
    expect(result).toBe('free-form server message')
  })

  it('reads `message` when neither `error` nor `code` is on the input (Error-like)', () => {
    const result = tApiError(new Error('plain error'))
    expect(result).toBe('plain error')
  })

  it('returns empty string for null / undefined input', () => {
    expect(tApiError(null)).toBe('')
    expect(tApiError(undefined)).toBe('')
  })
})
