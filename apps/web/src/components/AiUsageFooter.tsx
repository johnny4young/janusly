/**
 * Per-node AI usage footer. Renders only when the selected
 * `RunNode.stateJson.output` carries a usage object — i.e. the executor
 * actually ran an LLM call (the `ai` node). Reads provider / model /
 * tokens / cost / latency from the persisted output wrapper; falls back
 * gracefully when individual fields are missing.
 *
 * Used by:
 * - `InspectorPanel.tsx` (mounted in the per-node detail card).
 * - `AiUsageFooter.test.tsx` (pins the contract independently so the
 *   focused jsdom test can mount it without the whole RightPanel).
 */

import React from 'react'
import type { JsonObject } from '../types'

export function AiUsageFooter({ stateJson }: { stateJson?: JsonObject | null }) {
  if (!stateJson || typeof stateJson !== 'object') return null
  const state = stateJson as Record<string, unknown>
  const obj = state.output && typeof state.output === 'object'
    ? state.output as Record<string, unknown>
    : state
  const usage = obj.usage as Record<string, unknown> | undefined
  if (!usage || typeof usage !== 'object') return null
  const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : null
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : null
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : null
  const model = typeof obj.model === 'string' ? obj.model : null
  const provider = typeof obj.provider === 'string' ? obj.provider : null
  const costUsd = typeof obj.costUsd === 'number' ? obj.costUsd : null
  const latencyMs = typeof obj.latencyMs === 'number' ? obj.latencyMs : null

  const tokenSummary = totalTokens != null
    ? `${totalTokens} tokens`
    : inputTokens != null || outputTokens != null
      ? `${inputTokens ?? 0}/${outputTokens ?? 0} tokens`
      : null

  return (
    <div className="inspector-meta" data-testid="ai-usage-footer">
      {model && <span>{provider ? `${model} (${provider})` : model}</span>}
      {tokenSummary && <span>{tokenSummary}</span>}
      {costUsd != null && <span>${costUsd.toFixed(6)}</span>}
      {latencyMs != null && <span>{latencyMs}ms</span>}
    </div>
  )
}
