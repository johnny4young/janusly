import {
  formatSimpleComparisonExpression,
  parseSimpleComparisonExpression,
  SIMPLE_COMPARISON_OPERATORS,
  type SimpleComparisonOperator,
} from '@/lib/expression'
import type { ExpressionSuggestion } from './expression-context'

export type BranchRuleMode = 'always' | 'simple' | 'advanced'
export type BranchRuleValueKind = 'text' | 'number' | 'boolean'
export type BranchRuleDraft = {
  left: string
  operator: GuidedComparisonOperator
  valueKind: BranchRuleValueKind
  value: string
}
export type BranchRuleAuthoring = {
  mode: BranchRuleMode
  draft: BranchRuleDraft
}
type BranchRuleSource = Pick<ExpressionSuggestion, 'token' | 'nodeId' | 'valueType'>

export const GUIDED_COMPARISON_OPERATORS = SIMPLE_COMPARISON_OPERATORS
export type GuidedComparisonOperator = SimpleComparisonOperator

export function resolveBranchRuleAuthoring(
  value: string,
  allowUnconditional: boolean,
  sources: BranchRuleSource[],
  preferredNodeId?: string,
): BranchRuleAuthoring {
  const trimmed = value.trim()
  const parsed = branchRuleDraftFromExpression(value)
  const draft = parsed && sources.some(source => source.token === parsed.left) ? parsed : null
  return {
    mode: (allowUnconditional ? !trimmed : trimmed === 'true')
      ? 'always'
      : draft ? 'simple' : 'advanced',
    draft: draft ?? defaultBranchRuleDraft(sources, preferredNodeId),
  }
}

export function branchRuleDraftFromExpression(expression: string): BranchRuleDraft | null {
  const parsed = parseSimpleComparisonExpression(expression)
  if (!parsed) return null
  if (
    typeof parsed.right === 'boolean'
    && parsed.operator !== '==='
    && parsed.operator !== '!=='
  ) return null

  const valueKind = typeof parsed.right === 'boolean'
    ? 'boolean'
    : typeof parsed.right === 'number'
      ? 'number'
      : 'text'
  return { left: parsed.left, operator: parsed.operator, valueKind, value: String(parsed.right) }
}

export function defaultBranchRuleDraft(
  candidates: BranchRuleSource[],
  preferredNodeId?: string,
): BranchRuleDraft {
  const preferred = preferredNodeId
    ? candidates.find(item => item.nodeId === preferredNodeId)
    : undefined
  const source = preferred ?? candidates.find(item => sourceValueKind(item) === 'boolean')
    ?? candidates.find(item => sourceValueKind(item) === 'number')
    ?? candidates[0]
  const valueKind = sourceValueKind(source)
  return {
    left: source?.token ?? 'context.input.value',
    operator: '===',
    valueKind,
    value: valueKind === 'boolean'
      ? 'true'
      : valueKind === 'number'
        ? source?.token.endsWith('.statusCode') ? '200' : '0'
        : '',
  }
}

export function formatBranchRuleDraft(draft: BranchRuleDraft): string {
  const left = draft.left.trim()
  let right: string | number | boolean | undefined = draft.value
  if (draft.valueKind === 'boolean') right = draft.value === 'true'
  if (draft.valueKind === 'number') {
    const number = Number(draft.value)
    right = draft.value.trim() && Number.isFinite(number) ? number : undefined
  }
  const formatted = left && right !== undefined
    ? formatSimpleComparisonExpression({ left, operator: draft.operator, right })
    : null
  return formatted ?? 'invalid'
}

function sourceValueKind(source: BranchRuleSource | undefined): BranchRuleValueKind {
  const type = source?.valueType
  if (type === 'boolean' || type === 'number') return type
  return ({
    ok: 'boolean',
    result: 'boolean',
    jsonParseError: 'boolean',
    statusCode: 'number',
    count: 'number',
    waitedMs: 'number',
  } as const)[source?.token.split('.').pop() ?? ''] ?? 'text'
}
