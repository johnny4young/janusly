import { describe, expect, it } from 'vitest'
import {
  evaluateExpression,
  formatSimpleComparisonExpression,
  parseSimpleComparisonExpression,
  validateExpression,
} from './expression'

describe('evaluateExpression', () => {
  const scope = {
    context: {
      http: { output: { statusCode: 200, ok: true } },
      approval: { output: { decision: 'approved' } },
      customer: {
        output: {
          createdAt: '2026-07-14T12:30:00Z',
          email: 'operator@example.com',
          message: 'payment failed: card declined',
          tags: ['priority', 'billing'],
        },
      },
    },
    inputs: { threshold: 10, allowedTags: ['billing', 'support'] },
  }

  it('evaluates allowed comparisons and boolean operators', () => {
    expect(evaluateExpression("context.http.output.statusCode === 200 && context.http.output.ok === true", scope)).toBe(true)
    expect(evaluateExpression("context.approval.output.decision === 'rejected' || inputs.threshold >= 10", scope)).toBe(true)
  })

  it('evaluates parenthesized boolean groups composed with further operators', () => {
    expect(evaluateExpression("(context.http.output.statusCode === 200 || false) && !false", scope)).toBe(true)
    expect(evaluateExpression('(true || false) && true', scope)).toBe(true)
    // Grouping must actually override the ||-splits-first precedence.
    expect(evaluateExpression('(true || false) && false', scope)).toBe(false)
    expect(evaluateExpression('true || false && false', scope)).toBe(true)
    expect(evaluateExpression('!(context.http.output.ok === false || context.http.output.statusCode === 500)', scope)).toBe(true)
    expect(evaluateExpression('((context.http.output.ok === true && inputs.threshold >= 10) || (false && true))', scope)).toBe(true)
    // Parens inside quoted strings are literal text, never grouping.
    expect(evaluateExpression("'(a || b)' === '(a || b)'", scope)).toBe(true)
    expect(validateExpression("(context.http.output.statusCode === 200 || false) && !false").valid).toBe(true)
    // Static validation still visits every branch inside a paren group.
    expect(validateExpression("(true || context.value startsWith 123) && true").valid).toBe(false)
  })

  it('rejects expressions that try to execute arbitrary code', () => {
    expect(validateExpression('process.exit()')).toEqual({
      valid: false,
      message: 'Unsupported expression token: process.exit()',
      code: 'unsupported_token',
      token: 'process.exit()',
    })
    expect(validateExpression('context.http.output.ok; process.exit()').valid).toBe(false)
    expect(validateExpression('context.customer.output.message.includes("failed")').valid).toBe(false)
    expect(validateExpression('context.customer.output.message matches /failed/').valid).toBe(false)
  })

  it('supports string and collection operators without function calls', () => {
    expect(evaluateExpression("context.customer.output.message contains 'card declined'", scope)).toBe(true)
    expect(evaluateExpression("context.customer.output.email startsWith 'operator@'", scope)).toBe(true)
    expect(evaluateExpression("context.customer.output.message matches 'payment *: card ?eclined'", scope)).toBe(true)
    expect(evaluateExpression("'billing' in context.customer.output.tags", scope)).toBe(true)
    expect(evaluateExpression("context.approval.output.decision in ['approved', 'review']", scope)).toBe(true)
    expect(evaluateExpression("'fraud' in inputs.allowedTags", scope)).toBe(false)
    expect(evaluateExpression("context.customer.output.tags contains 'priority'", scope)).toBe(true)
    expect(evaluateExpression('true in [false, true, null, 1]', scope)).toBe(true)
  })

  it('compares strings lexicographically while preserving numeric comparisons', () => {
    expect(evaluateExpression("context.customer.output.createdAt >= '2026-07-01T00:00:00Z'", scope)).toBe(true)
    expect(evaluateExpression("context.customer.output.createdAt < '2027-01-01T00:00:00Z'", scope)).toBe(true)
    expect(evaluateExpression("'10' < '2'", scope)).toBe(true)
    expect(evaluateExpression("inputs.threshold > 2", scope)).toBe(true)
    expect(evaluateExpression("inputs.threshold > '2'", scope)).toBe(true)
  })

  it('validates operator contracts against empty scopes and keeps runtime type drift non-fatal', () => {
    expect(validateExpression("context.customer.output.message contains 'failed'").valid).toBe(true)
    expect(validateExpression("context.customer.output.email startsWith 'operator'").valid).toBe(true)
    expect(validateExpression("context.customer.output.message matches '*failed*'").valid).toBe(true)
    expect(validateExpression("context.approval.output.decision in ['approved', 'rejected']").valid).toBe(true)
    expect(validateExpression("context.customer.output.createdAt >= '2026-01-01'").valid).toBe(true)
    expect(validateExpression("context.value in 'not-an-array'").valid).toBe(false)
    expect(validateExpression('context.value startsWith 123').valid).toBe(false)
    expect(validateExpression('context.value matches 123').valid).toBe(false)
    expect(validateExpression('context.value > true').valid).toBe(false)
    expect(validateExpression("false && context.value in 'not-an-array'").valid).toBe(false)
    expect(validateExpression('true || context.value startsWith 123').valid).toBe(false)
    expect(validateExpression('context.value in [context.other]').valid).toBe(false)
    expect(validateExpression("context.value in [['nested']]").valid).toBe(false)

    expect(evaluateExpression('context.http.output.ok > 0', scope)).toBe(false)
    expect(evaluateExpression("context.http.output.statusCode contains '20'", scope)).toBe(false)
    expect(evaluateExpression("'approved' in context.approval.output.decision", scope)).toBe(false)
  })

  it('bounds glob matching and handles long wildcard inputs in linear time', () => {
    const longScope = { context: { value: `${'a'.repeat(10_000)}z` }, inputs: {} }
    expect(evaluateExpression("context.value matches 'a*z'", longScope)).toBe(true)
    expect(validateExpression(`context.value matches '${'*'.repeat(257)}'`).valid).toBe(false)
    expect(() => evaluateExpression(`'value' matches '${'*'.repeat(257)}'`, scope))
      .toThrow(/pattern exceeds 256 characters/)
  })

  it('refuses to compare a ReadableStream-typed context value (clear error, no silent coercion)', () => {
    // Defense-in-depth mirroring the template-side guard. If a streaming
    // HTTP node's live stream ever escapes into context, the condition
    // evaluator must NOT coerce it to a string and silently produce a
    // wrong boolean — surface a precise error instead.
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.close() } })
    const scope = { context: { http: { output: { body: stream } } }, inputs: {} }
    expect(() => evaluateExpression("context.http.output.body === 'ok'", scope))
      .toThrow(/ReadableStream/)
  })

  it('round-trips one path-versus-literal comparison for guided authoring', () => {
    expect(parseSimpleComparisonExpression("context.http.output.statusCode >= 200")).toEqual({
      left: 'context.http.output.statusCode',
      operator: '>=',
      right: 200,
    })
    expect(parseSimpleComparisonExpression(
      "context.approval.output.decision in ['approved', 'review']",
    )).toBeNull()
    expect(formatSimpleComparisonExpression({
      left: 'context.approval.output.decision',
      operator: '===',
      right: "owner's review",
    })).toBe('context.approval.output.decision === "owner\'s review"')
    const windowsPath = String.raw`C:\temp`
    const formattedPath = formatSimpleComparisonExpression({
      left: 'context.input.path',
      operator: '===',
      right: windowsPath,
    })
    expect(formattedPath).toBe(String.raw`context.input.path === 'C:\temp'`)
    expect(parseSimpleComparisonExpression(formattedPath!)).toMatchObject({ right: windowsPath })
  })

  it('keeps complex or loss-prone expressions out of guided round trips', () => {
    expect(parseSimpleComparisonExpression(
      'context.http.output.ok === true && context.http.output.statusCode === 200',
    )).toBeNull()
    expect(parseSimpleComparisonExpression("'approved' in context.approval.output.decision")).toBeNull()
    expect(formatSimpleComparisonExpression({
      left: 'context.approval.output.decision',
      operator: '===',
      right: `can't "escape" both`,
    })).toBeNull()
    expect(formatSimpleComparisonExpression({
      left: 'process.env.SECRET',
      operator: '===',
      right: 'nope',
    })).toBeNull()
  })
})
