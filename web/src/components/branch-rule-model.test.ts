import { describe, expect, it } from 'vitest'
import {
  branchRuleDraftFromExpression,
  defaultBranchRuleDraft,
  formatBranchRuleDraft,
  resolveBranchRuleAuthoring,
} from './branch-rule-model'

describe('branch rule model', () => {
  it('classifies unconditional, guided, and advanced expressions without rewriting them', () => {
    const sources = [{ token: 'context.input.priority', kind: 'input' as const }]
    expect(resolveBranchRuleAuthoring('', true, sources).mode).toBe('always')
    expect(resolveBranchRuleAuthoring('true', false, sources).mode).toBe('always')
    expect(resolveBranchRuleAuthoring("context.input.priority === 'high'", false, sources).mode).toBe('simple')
    expect(resolveBranchRuleAuthoring(
      "context.input.priority === 'high' && context.input.amount > 100",
      false,
      sources,
    ).mode).toBe('advanced')
  })

  it('parses and formats supported scalar comparisons', () => {
    expect(branchRuleDraftFromExpression('context.fetch.output.statusCode >= 200')).toEqual({
      left: 'context.fetch.output.statusCode',
      operator: '>=',
      valueKind: 'number',
      value: '200',
    })
    expect(formatBranchRuleDraft({
      left: 'context.input.priority',
      operator: '===',
      valueKind: 'text',
      value: 'high',
    })).toBe("context.input.priority === 'high'")
  })

  it('keeps list, loose-equality, and compound expressions in advanced mode', () => {
    expect(branchRuleDraftFromExpression("context.input.priority in ['high', 'urgent']")).toBeNull()
    expect(branchRuleDraftFromExpression("context.input.amount == '100'")).toBeNull()
    expect(branchRuleDraftFromExpression(
      'context.input.amount > 100 || context.input.override === true',
    )).toBeNull()
  })

  it('chooses the nearest useful boolean or typed source for a new rule', () => {
    const suggestions = [
      { token: 'context.fetch.output.body', kind: 'upstream', valueType: 'string' },
      { token: 'context.fetch.output.statusCode', kind: 'upstream', valueType: 'number' },
      { token: 'context.fetch.output.ok', kind: 'upstream', nodeId: 'fetch', valueType: 'boolean' },
      { token: 'context.gate.output.result', kind: 'upstream', nodeId: 'gate', valueType: 'boolean' },
    ] as const
    expect(defaultBranchRuleDraft([...suggestions])).toEqual({
      left: 'context.fetch.output.ok',
      operator: '===',
      valueKind: 'boolean',
      value: 'true',
    })
    expect(defaultBranchRuleDraft([...suggestions], 'gate')).toMatchObject({
      left: 'context.gate.output.result',
    })
  })

  it('emits an invalid expression instead of silently retaining an old valid rule', () => {
    expect(formatBranchRuleDraft({
      left: '',
      operator: '===',
      valueKind: 'number',
      value: '',
    })).toBe('invalid')
  })
})
