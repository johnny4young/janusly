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
})
