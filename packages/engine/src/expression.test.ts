import { describe, expect, it } from 'vitest'
import { evaluateExpression, validateExpression } from './expression'

describe('evaluateExpression', () => {
  const scope = {
    context: {
      http: { output: { statusCode: 200, ok: true } },
      approval: { output: { decision: 'approved' } },
    },
    inputs: { threshold: 10 },
  }

  it('evaluates allowed comparisons and boolean operators', () => {
    expect(evaluateExpression("context.http.output.statusCode === 200 && context.http.output.ok === true", scope)).toBe(true)
    expect(evaluateExpression("context.approval.output.decision === 'rejected' || inputs.threshold >= 10", scope)).toBe(true)
  })

  it('rejects expressions that try to execute arbitrary code', () => {
    expect(validateExpression('process.exit()').valid).toBe(false)
    expect(validateExpression('context.http.output.ok; process.exit()').valid).toBe(false)
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
})
