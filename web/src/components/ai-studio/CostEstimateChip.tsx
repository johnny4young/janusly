import { useMemo } from 'react'
import { estimatePromptCostUsd, formatEstimateLabel } from '@/lib/llm-pricing'
import { ASSUMED_TOKEN_BUDGETS } from './model'

export function CostEstimateChip({
  action,
  model,
}: {
  action: 'proposal' | 'explain' | 'review' | 'fix'
  model?: string
}) {
  const label = useMemo(() => {
    if (!model) return null
    const budget = ASSUMED_TOKEN_BUDGETS[action]
    const cost = estimatePromptCostUsd(model, budget.input, budget.output)
    if (cost === null) return null
    return formatEstimateLabel(cost)
  }, [action, model])
  if (!label) return null
  return <small className="ai-studio-cost-chip" data-testid={'ai-cost-' + action} aria-hidden="true">{label}</small>
}
